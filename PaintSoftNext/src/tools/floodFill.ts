export interface FloodFillOptions {
  /** 0..255 per-channel slack, so near-identical anti-aliased pixels join the region. */
  tolerance?: number;
  /**
   * Optional selection coverage, one byte per pixel. Where coverage is low the fill both
   * stops spreading and stops writing, so the selection acts as a boundary rather than
   * merely cropping the result — a fill started inside a selection cannot leak out of it.
   */
  selectionMask?: Uint8Array | null;
}

/**
 * Scanline flood fill, in place, over un-premultiplied RGBA.
 *
 * Uses the span-based algorithm rather than a per-pixel stack: each iteration claims a
 * whole horizontal run and only pushes the rows above and below where the run's coverage
 * actually changes. That keeps the worklist proportional to the number of spans rather
 * than to filled pixels, which matters because a bucket fill on a mostly-empty layer of a
 * large canvas is exactly the degenerate case for the naive four-way version.
 *
 * Returns false when the click lands outside the image or on a pixel that already matches
 * the fill colour, so callers can skip the texture upload and the undo entry.
 */
export function floodFill(
  image: ImageData,
  startX: number,
  startY: number,
  color: readonly [number, number, number],
  options: FloodFillOptions = {},
): boolean {
  const { width, height, data } = image;
  const x0 = Math.floor(startX);
  const y0 = Math.floor(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return false;

  const tolerance = options.tolerance ?? 24;
  const start = (y0 * width + x0) * 4;

  const targetR = data[start]!;
  const targetG = data[start + 1]!;
  const targetB = data[start + 2]!;
  const targetA = data[start + 3]!;

  const [fillR, fillG, fillB] = color;
  if (targetA === 255 && targetR === fillR && targetG === fillG && targetB === fillB) return false;

  const selectionMask = options.selectionMask ?? null;
  if (selectionMask && selectionMask[y0 * width + x0]! < 128) return false;

  const matches = (offset: number): boolean => {
    if (selectionMask && selectionMask[offset >> 2]! < 128) return false;
    const alpha = data[offset + 3]!;
    // Fully transparent pixels have no meaningful colour, so transparency itself is the
    // thing being matched — otherwise filling empty canvas would depend on leftover RGB.
    if (targetA === 0) return alpha === 0;
    if (alpha === 0) return false;
    return (
      Math.abs(data[offset]! - targetR) <= tolerance &&
      Math.abs(data[offset + 1]! - targetG) <= tolerance &&
      Math.abs(data[offset + 2]! - targetB) <= tolerance &&
      Math.abs(alpha - targetA) <= tolerance
    );
  };

  const filled = new Uint8Array(width * height);
  const stack: number[] = [x0, y0];
  let changed = false;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;

    const rowStart = y * width;
    if (filled[rowStart + x] === 1) continue;
    if (!matches((rowStart + x) * 4)) continue;

    let left = x;
    while (left > 0 && filled[rowStart + left - 1] !== 1 && matches((rowStart + left - 1) * 4)) left -= 1;

    let right = x;
    while (right < width - 1 && filled[rowStart + right + 1] !== 1 && matches((rowStart + right + 1) * 4)) {
      right += 1;
    }

    for (let i = left; i <= right; i += 1) {
      const offset = (rowStart + i) * 4;
      data[offset] = fillR;
      data[offset + 1] = fillG;
      data[offset + 2] = fillB;
      data[offset + 3] = 255;
      filled[rowStart + i] = 1;
      changed = true;
    }

    // Seed the neighbouring rows once per contiguous unfilled run, not once per pixel.
    for (const neighbourY of [y - 1, y + 1]) {
      if (neighbourY < 0 || neighbourY >= height) continue;
      const neighbourRow = neighbourY * width;

      let inRun = false;
      for (let i = left; i <= right; i += 1) {
        const candidate = filled[neighbourRow + i] !== 1 && matches((neighbourRow + i) * 4);
        if (candidate && !inRun) {
          stack.push(i, neighbourY);
          inRun = true;
        } else if (!candidate) {
          inRun = false;
        }
      }
    }
  }

  return changed;
}
