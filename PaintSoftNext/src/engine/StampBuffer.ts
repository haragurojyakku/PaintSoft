import { STAMP_STRIDE } from './gl/StampBatch';

export interface StampBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Growable packed [x, y, radius, alpha] store that the brush engine fills and the GPU
 * consumes verbatim as an instance buffer — no per-stamp objects, no re-packing step.
 *
 * Also accumulates the bounding box of everything pushed since the last `reset`, which
 * is what lets the renderer scissor its per-frame work down to the region a stroke
 * actually touched instead of redoing the whole canvas.
 */
export class StampBuffer {
  data: Float32Array;
  count = 0;

  // Centres only, with the radius kept separately: a stamp's reach past its centre scales
  // with its own radius (a soft brush's halo is `radius * spread`, not a fixed margin), so
  // the influence margin can only be applied once the caller's spread factor is known.
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxRadius = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Float32Array(initialCapacity * STAMP_STRIDE);
  }

  get capacity(): number {
    return this.data.length / STAMP_STRIDE;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  push(x: number, y: number, radius: number, alpha: number): void {
    if (this.count >= this.capacity) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }

    const offset = this.count * STAMP_STRIDE;
    this.data[offset] = x;
    this.data[offset + 1] = y;
    this.data[offset + 2] = radius;
    this.data[offset + 3] = alpha;
    this.count += 1;

    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (radius > this.maxRadius) this.maxRadius = radius;
  }

  /**
   * Bounding box of the stamps pushed since the last reset, in document pixels, or null if
   * nothing was pushed.
   *
   * @param spread Outer-radius multiplier for the current brush (1 for a hard edge, up to
   *   1 + AIRBRUSH_SPREAD for a fully soft one). Applied to the largest radius in the batch,
   *   which over-covers the smaller stamps — deliberately, since a box that is slightly too
   *   big only costs a few fragments whereas one that is too small leaves visible seams.
   * @param padding Extra constant margin, for the shader's one-pixel guard band.
   */
  bounds(spread = 1, padding = 0): StampBounds | null {
    if (this.count === 0) return null;
    const reach = this.maxRadius * spread + padding;
    return {
      minX: this.minX - reach,
      minY: this.minY - reach,
      maxX: this.maxX + reach,
      maxY: this.maxY + reach,
    };
  }

  reset(): void {
    this.count = 0;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
    this.maxRadius = 0;
  }
}
