import type { Rect } from '../engine/gl/Compositor';

export interface Point {
  x: number;
  y: number;
}

export type SelectionMode = 'replace' | 'add' | 'subtract';

/** Vertical sub-samples per pixel row. Horizontal coverage is computed exactly. */
const SUBSAMPLES = 4;

/**
 * The active selection, held as an 8-bit coverage mask on the CPU.
 *
 * CPU-side rather than GPU-side because most of what a selection does is not drawing:
 * flood fill has to respect it, "clear inside" has to read it, and invert/add/subtract are
 * trivial array passes. The engine uploads it to a single-channel texture whenever it
 * changes, which is rare compared to how often it is consulted.
 *
 * `null` coverage means *no* active selection, which is distinct from an empty one: with no
 * selection every operation is unconstrained, whereas an empty selection blocks everything.
 */
export class Selection {
  private mask: Uint8Array | null = null;
  private cachedBounds: Rect | null | undefined;

  constructor(
    public width: number,
    public height: number,
  ) {}

  get isActive(): boolean {
    return this.mask !== null;
  }

  get data(): Uint8Array | null {
    return this.mask;
  }

  /** Coverage 0..255 at a pixel; 255 everywhere when nothing is selected. */
  coverageAt(x: number, y: number): number {
    if (!this.mask) return 255;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return 0;
    return this.mask[py * this.width + px]!;
  }

  deselect(): void {
    this.mask = null;
    this.cachedBounds = undefined;
  }

  /** Replaces the mask wholesale — used to restore a snapshot while a drag is in progress. */
  setMask(mask: Uint8Array | null): void {
    this.mask = mask && mask.length === this.width * this.height ? mask : null;
    this.cachedBounds = undefined;
  }

  selectAll(): void {
    this.mask = new Uint8Array(this.width * this.height).fill(255);
    this.cachedBounds = undefined;
  }

  invert(): void {
    if (!this.mask) {
      // Inverting "no selection" is inverting everything, which selects nothing.
      this.mask = new Uint8Array(this.width * this.height);
    } else {
      for (let i = 0; i < this.mask.length; i += 1) this.mask[i] = 255 - this.mask[i]!;
    }
    this.cachedBounds = undefined;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // A mask is only meaningful at the size it was made for; carrying it across a resize
    // would silently misalign it with the artwork.
    this.deselect();
  }

  setRect(rect: Rect, mode: SelectionMode = 'replace'): void {
    const shape = new Uint8Array(this.width * this.height);
    rasterizeRect(shape, this.width, this.height, rect);
    this.combine(shape, mode);
  }

  setPolygon(points: readonly Point[], mode: SelectionMode = 'replace'): void {
    if (points.length < 3) {
      if (mode === 'replace') this.deselect();
      return;
    }
    const shape = new Uint8Array(this.width * this.height);
    rasterizePolygon(shape, this.width, this.height, points);
    this.combine(shape, mode);
  }

  private combine(shape: Uint8Array, mode: SelectionMode): void {
    if (mode === 'replace' || !this.mask) {
      this.mask = mode === 'subtract' && !this.mask ? invertedCopy(shape) : shape;
      this.cachedBounds = undefined;
      this.dropIfEmpty();
      return;
    }

    const mask = this.mask;
    if (mode === 'add') {
      for (let i = 0; i < mask.length; i += 1) mask[i] = Math.max(mask[i]!, shape[i]!);
    } else {
      for (let i = 0; i < mask.length; i += 1) mask[i] = Math.min(mask[i]!, 255 - shape[i]!);
    }
    this.cachedBounds = undefined;
    this.dropIfEmpty();
  }

  /** A selection that covers nothing is indistinguishable from having none, and confusing. */
  private dropIfEmpty(): void {
    if (!this.mask) return;
    for (const value of this.mask) {
      if (value !== 0) return;
    }
    this.deselect();
  }

  /** Tight bounds of the selected area, or null when nothing is selected. */
  bounds(): Rect | null {
    if (this.cachedBounds !== undefined) return this.cachedBounds;
    this.cachedBounds = this.computeBounds();
    return this.cachedBounds;
  }

  private computeBounds(): Rect | null {
    if (!this.mask) return null;

    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < this.height; y += 1) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x += 1) {
        if (this.mask[row + x] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
}

export function cloneMask(mask: Uint8Array | null): Uint8Array | null {
  return mask ? new Uint8Array(mask) : null;
}

/**
 * Removes the selected pixels from `image`, feathering by the selection's own coverage so
 * an anti-aliased lasso edge does not leave a hard step behind.
 *
 * `image` is un-premultiplied (that is what the engine hands back), so erasing is purely a
 * matter of scaling alpha down.
 */
export function eraseSelection(image: ImageData, selection: Selection): void {
  forEachSelected(image, selection, (offset, coverage) => {
    image.data[offset + 3] = Math.round(image.data[offset + 3]! * (1 - coverage));
  });
}

/** Composites a solid colour over the selected pixels, again weighted by coverage. */
export function fillSelection(
  image: ImageData,
  selection: Selection,
  color: readonly [number, number, number],
): void {
  const [red, green, blue] = color;

  forEachSelected(image, selection, (offset, coverage) => {
    const backdropAlpha = image.data[offset + 3]! / 255;
    const outAlpha = coverage + backdropAlpha * (1 - coverage);
    if (outAlpha <= 0) {
      image.data[offset + 3] = 0;
      return;
    }

    // Standard source-over on straight (un-premultiplied) colours.
    const mix = (source: number, backdrop: number) =>
      Math.round((source * coverage + backdrop * backdropAlpha * (1 - coverage)) / outAlpha);

    image.data[offset] = mix(red, image.data[offset]!);
    image.data[offset + 1] = mix(green, image.data[offset + 1]!);
    image.data[offset + 2] = mix(blue, image.data[offset + 2]!);
    image.data[offset + 3] = Math.round(outAlpha * 255);
  });
}

/**
 * Visits every pixel the selection touches, passing 0..1 coverage. With no active selection
 * the whole image counts as selected, matching how drawing behaves.
 */
function forEachSelected(
  image: ImageData,
  selection: Selection,
  visit: (offset: number, coverage: number) => void,
): void {
  const mask = selection.data;
  const bounds = selection.bounds() ?? { x: 0, y: 0, width: image.width, height: image.height };

  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(image.width, bounds.x + bounds.width);
  const bottom = Math.min(image.height, bounds.y + bounds.height);

  for (let y = top; y < bottom; y += 1) {
    const row = y * image.width;
    for (let x = left; x < right; x += 1) {
      const coverage = mask ? mask[row + x]! / 255 : 1;
      if (coverage <= 0) continue;
      visit((row + x) * 4, coverage);
    }
  }
}

function invertedCopy(shape: Uint8Array): Uint8Array {
  const out = new Uint8Array(shape.length);
  for (let i = 0; i < shape.length; i += 1) out[i] = 255 - shape[i]!;
  return out;
}

function rasterizeRect(out: Uint8Array, width: number, height: number, rect: Rect): void {
  const left = Math.max(0, Math.min(width, rect.x));
  const right = Math.max(0, Math.min(width, rect.x + rect.width));
  const top = Math.max(0, Math.min(height, rect.y));
  const bottom = Math.max(0, Math.min(height, rect.y + rect.height));
  if (right <= left || bottom <= top) return;

  for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
    // Fractional coverage at the edges keeps a marquee dragged to non-integer coordinates
    // from snapping visibly as it moves.
    const rowCoverage = Math.max(0, Math.min(y + 1, bottom) - Math.max(y, top));
    if (rowCoverage <= 0) continue;

    const row = y * width;
    for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
      const columnCoverage = Math.max(0, Math.min(x + 1, right) - Math.max(x, left));
      out[row + x] = Math.round(Math.min(1, rowCoverage * columnCoverage) * 255);
    }
  }
}

/**
 * Even-odd scanline fill with 4x vertical sub-sampling and exact horizontal span coverage,
 * so a lasso edge is anti-aliased rather than a staircase.
 */
function rasterizePolygon(
  out: Uint8Array,
  width: number,
  height: number,
  points: readonly Point[],
): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const firstRow = Math.max(0, Math.floor(minY));
  const lastRow = Math.min(height - 1, Math.ceil(maxY));
  const coverage = new Float32Array(width);
  const crossings: number[] = [];

  for (let y = firstRow; y <= lastRow; y += 1) {
    coverage.fill(0);

    for (let sub = 0; sub < SUBSAMPLES; sub += 1) {
      const sampleY = y + (sub + 0.5) / SUBSAMPLES;
      crossings.length = 0;

      for (let i = 0; i < points.length; i += 1) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        // Half-open comparison so a vertex exactly on the sample line is counted once.
        if (a.y <= sampleY === b.y <= sampleY) continue;
        crossings.push(a.x + ((sampleY - a.y) / (b.y - a.y)) * (b.x - a.x));
      }

      crossings.sort((p, q) => p - q);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        addSpan(coverage, crossings[i]!, crossings[i + 1]!, width, 1 / SUBSAMPLES);
      }
    }

    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = coverage[x]!;
      if (value > 0) out[row + x] = Math.round(Math.min(1, value) * 255);
    }
  }
}

function addSpan(
  coverage: Float32Array,
  from: number,
  to: number,
  width: number,
  weight: number,
): void {
  const start = Math.max(0, from);
  const end = Math.min(width, to);
  if (end <= start) return;

  for (let x = Math.floor(start); x < end; x += 1) {
    const overlap = Math.min(end, x + 1) - Math.max(start, x);
    if (overlap > 0) coverage[x] += overlap * weight;
  }
}
