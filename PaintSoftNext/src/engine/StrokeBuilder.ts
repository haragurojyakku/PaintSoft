import type { StampBuffer } from './StampBuffer';

/** How brush size is interpreted. */
export type SizeUnit =
  /** Size is in document pixels: zooming in shows the brush bigger, as in CSP/Photoshop. */
  | 'document'
  /** Size is in on-screen pixels: the brush always looks the same size regardless of zoom (v1's behaviour). */
  | 'screen';

export interface BrushSettings {
  size: number;
  sizeMinPercent: number;
  sizeMaxPercent: number;
  sizePressureEnabled: boolean;

  opacity: number;
  opacityMinPercent: number;
  opacityMaxPercent: number;
  opacityPressureEnabled: boolean;

  blur: number;
  spacingPercent: number;
  sizeUnit: SizeUnit;
  /**
   * Whether overlapping stamps within one stroke darken each other. Not used by the
   * stamp-generation maths here, but it belongs to the brush rather than to the app, so it
   * travels with the rest of the settings into presets and storage.
   */
  buildup: boolean;
}

export interface StabilizerSettings {
  /** 手ブレ補正: 0..95, mapped to a rolling-average window of 1..20 position samples. */
  positionStrength: number;
  /** 筆圧補正: 0..95, with its own independent window over pressure samples. */
  pressureStrength: number;
}

export interface StrokeContext {
  brush: BrushSettings;
  stabilizer: StabilizerSettings;
  /**
   * Document pixels per on-screen pixel, used only when `sizeUnit` is 'screen'.
   * Equivalent to v1's getCanvasPixelScale().
   */
  pixelScale: number;
}

/**
 * Turns a stream of pointer samples into brush stamps.
 *
 * Split out from rendering entirely: this class never touches a canvas or a GL context,
 * it only appends [x, y, radius, alpha] tuples to a StampBuffer. That separation is what
 * lets the renderer batch a whole frame's worth of stamps into one instanced draw call,
 * and it makes the spacing/pressure/stabiliser maths directly unit-testable.
 *
 * The stabiliser is a plain rolling arithmetic mean, matching v1: two independent windows
 * (hand wobble and sensor noise are different problems), each starting out holding only
 * the stroke's first sample so there is no lag on the initial dab.
 */
export class StrokeBuilder {
  private context: StrokeContext | null = null;

  private readonly positionWindow: { x: number; y: number }[] = [];
  private readonly pressureWindow: number[] = [];

  private lastX = 0;
  private lastY = 0;
  private smoothedPressure = 1;
  private distanceAccumulator = 0;

  get isActive(): boolean {
    return this.context !== null;
  }

  begin(x: number, y: number, pressure: number, context: StrokeContext, out: StampBuffer): void {
    this.context = context;
    this.positionWindow.length = 0;
    this.pressureWindow.length = 0;
    this.positionWindow.push({ x, y });
    this.pressureWindow.push(pressure);

    this.lastX = x;
    this.lastY = y;
    this.smoothedPressure = pressure;
    this.distanceAccumulator = 0;

    // The initial dab, so a tap leaves a mark rather than nothing.
    out.push(x, y, this.radius(), this.alpha());
  }

  move(x: number, y: number, pressure: number, out: StampBuffer): void {
    if (!this.context) return;

    // Captured before the pressure window is updated so the segment can interpolate from
    // the previous radius/alpha to the new one, instead of snapping the whole segment to
    // the new value (which reads as a terraced taper when a segment spans many stamps).
    const fromRadius = this.radius();
    const fromAlpha = this.alpha();

    const smoothed = this.pushPosition(x, y);
    this.smoothedPressure = this.pushPressure(pressure);

    this.emitSegment(smoothed.x, smoothed.y, fromRadius, fromAlpha, out);
  }

  /**
   * Stamps the remaining lag between the stabilised position/pressure and where the
   * pointer was actually released, so a heavily stabilised stroke still reaches its
   * endpoint. Repeatedly feeding the release values into each window converges within
   * max(window) iterations: once every sample in a window *is* the release value, that
   * window's mean is exactly the release value.
   */
  end(x: number, y: number, pressure: number, out: StampBuffer): void {
    if (!this.context) return;

    const iterations = Math.max(this.positionWindowSize(), this.pressureWindowSize());
    for (let i = 0; i < iterations; i += 1) {
      const fromRadius = this.radius();
      const fromAlpha = this.alpha();

      const smoothed = this.pushPosition(x, y);
      this.smoothedPressure = this.pushPressure(pressure);

      this.emitSegment(smoothed.x, smoothed.y, fromRadius, fromAlpha, out);

      const positionSettled = Math.hypot(x - this.lastX, y - this.lastY) < 0.5;
      const pressureSettled = Math.abs(pressure - this.smoothedPressure) < 0.01;
      if (positionSettled && pressureSettled) break;
    }

    this.context = null;
  }

  cancel(): void {
    this.context = null;
  }

  /**
   * Walks the segment from the previous stamped point to (toX, toY), emitting a stamp
   * every `spacing`% of the stamp diameter and carrying the leftover distance into the
   * next call so spacing stays even across segment boundaries.
   */
  private emitSegment(toX: number, toY: number, fromRadius: number, fromAlpha: number, out: StampBuffer): void {
    const toRadius = this.radius();
    const toAlpha = this.alpha();

    const maxRadius = Math.max(fromRadius, toRadius);
    if (maxRadius <= 0) return;

    const dx = toX - this.lastX;
    const dy = toY - this.lastY;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;

    const spacingPercent = Math.max(1, this.context?.brush.spacingPercent ?? 15);
    const step = Math.max(0.5, maxRadius * 2 * (spacingPercent / 100));

    let remaining = this.distanceAccumulator + distance;
    let stamped = 0;

    while (remaining >= step) {
      stamped += 1;
      const travelled = step * stamped - this.distanceAccumulator;
      const ratio = Math.max(0, Math.min(1, travelled / distance));

      out.push(
        this.lastX + dx * ratio,
        this.lastY + dy * ratio,
        fromRadius + (toRadius - fromRadius) * ratio,
        fromAlpha + (toAlpha - fromAlpha) * ratio,
      );

      remaining -= step;
    }

    this.distanceAccumulator = remaining;
    this.lastX = toX;
    this.lastY = toY;
  }

  private pushPosition(x: number, y: number): { x: number; y: number } {
    const windowSize = this.positionWindowSize();
    this.positionWindow.push({ x, y });
    while (this.positionWindow.length > windowSize) this.positionWindow.shift();

    let sumX = 0;
    let sumY = 0;
    for (const sample of this.positionWindow) {
      sumX += sample.x;
      sumY += sample.y;
    }
    const n = this.positionWindow.length;
    return { x: sumX / n, y: sumY / n };
  }

  private pushPressure(pressure: number): number {
    const windowSize = this.pressureWindowSize();
    this.pressureWindow.push(pressure);
    while (this.pressureWindow.length > windowSize) this.pressureWindow.shift();

    let sum = 0;
    for (const sample of this.pressureWindow) sum += sample;
    return sum / this.pressureWindow.length;
  }

  private positionWindowSize(): number {
    return strengthToWindowSize(this.context?.stabilizer.positionStrength ?? 0);
  }

  private pressureWindowSize(): number {
    return strengthToWindowSize(this.context?.stabilizer.pressureStrength ?? 0);
  }

  private radius(): number {
    const context = this.context;
    if (!context) return 0;

    const { brush } = context;
    const factor = pressureRangeFactor(
      brush.sizeMinPercent,
      brush.sizeMaxPercent,
      brush.sizePressureEnabled,
      this.smoothedPressure,
    );
    const size = brush.size * factor * (brush.sizeUnit === 'screen' ? context.pixelScale : 1);
    return size / 2;
  }

  private alpha(): number {
    const context = this.context;
    if (!context) return 0;

    const { brush } = context;
    const factor = pressureRangeFactor(
      brush.opacityMinPercent,
      brush.opacityMaxPercent,
      brush.opacityPressureEnabled,
      this.smoothedPressure,
    );
    return (Math.max(0, Math.min(100, brush.opacity)) / 100) * factor;
  }
}

/**
 * Shared spec for any "pressure range" parameter (both 太さ and 不透明度 use it): the value
 * sweeps between min% and max% driven by smoothed pressure, or sits at the max end when
 * that parameter's pressure toggle is off. Min and max are swapped if they cross, so the
 * range stays sane however the two sliders happen to be set relative to each other.
 */
export function pressureRangeFactor(
  minPercent: number,
  maxPercent: number,
  pressureEnabled: boolean,
  pressure: number,
): number {
  const a = Math.max(0, minPercent) / 100;
  const b = Math.max(0, maxPercent) / 100;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return low + (high - low) * (pressureEnabled ? pressure : 1);
}

/** Maps a 0..95 strength slider to a rolling window of 1 (off) to 20 samples. */
export function strengthToWindowSize(strength: number): number {
  const clamped = Math.max(0, Math.min(95, strength));
  return 1 + Math.round((clamped / 95) * 19);
}
