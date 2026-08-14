import { apply, composeAround, identity, invert, type Mat3 } from '../core/mat3';
import type { Point, Selection } from '../core/Selection';
import type { Engine } from '../engine/Engine';
import type { Rect } from '../engine/gl/Compositor';
import type { RenderTarget } from '../engine/gl/RenderTarget';

export type HandleId = 'nw' | 'ne' | 'se' | 'sw' | 'rotate' | 'move';

export interface TransformSession {
  layerId: number;
  floating: RenderTarget;
  /** Bounds of the lifted pixels, in document space. The pivot is its centre. */
  source: Rect;
  translate: Point;
  scale: Point;
  rotation: number;
}

/**
 * Move / scale / rotate for lifted pixels.
 *
 * The pixels are pulled out of their layer once, into a floating buffer, and the edit is
 * carried purely as a matrix until it is committed. Nothing is resampled while dragging, so
 * scaling down and back up loses no detail and the interaction cost is independent of how
 * large the moved area is.
 *
 * Handles are reported in *document* space; the caller maps them to the screen, which keeps
 * this free of any dependency on zoom, pan or the DOM.
 */
export class TransformTool {
  private session: TransformSession | null = null;
  private drag: {
    handle: HandleId;
    pointerId: number;
    startPointer: Point;
    startTranslate: Point;
    startScale: Point;
    startRotation: number;
    /** Pointer angle relative to the pivot when a rotation drag began. */
    startAngle: number;
  } | null = null;

  constructor(private readonly engine: Engine) {}

  get isActive(): boolean {
    return this.session !== null;
  }

  get current(): TransformSession | null {
    return this.session;
  }

  /**
   * Lifts the selected pixels (or the whole layer when nothing is selected) out of the
   * layer and into a floating buffer.
   *
   * The split is done on decoded pixels rather than with a GPU pass because the same
   * coverage weighting is needed twice, in opposite directions — the floating copy keeps
   * what the selection covers, the layer keeps what it does not — and doing both from one
   * readback avoids a second round trip.
   */
  begin(layerId: number, selection: Selection): TransformSession | null {
    this.cancel();

    const image = this.engine.exportLayerImageData(layerId);
    if (!image) return null;

    const bounds = selection.bounds() ?? usedBounds(image);
    if (!bounds) return null;

    const floatingImage = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    const remaining = image;

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        const coverage = selection.coverageAt(x, y) / 255;
        floatingImage.data[offset + 3] = Math.round(floatingImage.data[offset + 3]! * coverage);
        remaining.data[offset + 3] = Math.round(remaining.data[offset + 3]! * (1 - coverage));
      }
    }

    const floating = this.engine.createTargetFromImage(floatingImage);
    this.engine.uploadLayerImage(layerId, remaining);

    this.session = {
      layerId,
      floating,
      source: bounds,
      translate: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
    };

    this.engine.setFloating(layerId, floating, this.matrix());
    return this.session;
  }

  /** Merges the floating pixels back into their layer under the current transform. */
  commit(): void {
    if (!this.session) return;
    this.engine.commitFloating();
    this.session.floating.dispose();
    this.session = null;
    this.drag = null;
  }

  /** Puts the pixels back exactly where they came from. */
  cancel(): void {
    if (!this.session) return;

    this.session.translate = { x: 0, y: 0 };
    this.session.scale = { x: 1, y: 1 };
    this.session.rotation = 0;
    this.engine.updateFloatingTransform(this.matrix());
    this.engine.commitFloating();

    this.session.floating.dispose();
    this.session = null;
    this.drag = null;
  }

  get pivot(): Point {
    const source = this.session?.source;
    if (!source) return { x: 0, y: 0 };
    return { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  }

  matrix(): Mat3 {
    const session = this.session;
    if (!session) return identity();
    return composeAround(this.pivot, session.translate, session.scale, session.rotation);
  }

  /** The four transformed corners, document space, clockwise from the top-left. */
  corners(): Point[] {
    const session = this.session;
    if (!session) return [];

    const matrix = this.matrix();
    const { x, y, width, height } = session.source;
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ].map((corner) => apply(matrix, corner));
  }

  /** Midpoint above the top edge, where the rotation handle sits. */
  rotationHandle(): Point | null {
    const corners = this.corners();
    if (corners.length !== 4) return null;

    const [topLeft, topRight] = corners as [Point, Point, Point, Point];
    const midX = (topLeft.x + topRight.x) / 2;
    const midY = (topLeft.y + topRight.y) / 2;

    // Offset along the box's own outward normal so the handle follows the rotation.
    const edgeX = topRight.x - topLeft.x;
    const edgeY = topRight.y - topLeft.y;
    const length = Math.hypot(edgeX, edgeY) || 1;
    const scale = this.session ? Math.max(24, this.session.source.height * 0.15) : 24;

    return { x: midX + (edgeY / length) * scale, y: midY - (edgeX / length) * scale };
  }

  beginDrag(handle: HandleId, pointerId: number, pointer: Point): void {
    const session = this.session;
    if (!session) return;

    this.drag = {
      handle,
      pointerId,
      startPointer: pointer,
      startTranslate: { ...session.translate },
      startScale: { ...session.scale },
      startRotation: session.rotation,
      startAngle: this.angleFromPivot(pointer),
    };
  }

  updateDrag(pointerId: number, pointer: Point): boolean {
    const drag = this.drag;
    const session = this.session;
    if (!drag || !session || drag.pointerId !== pointerId) return false;

    if (drag.handle === 'move') {
      session.translate = {
        x: drag.startTranslate.x + (pointer.x - drag.startPointer.x),
        y: drag.startTranslate.y + (pointer.y - drag.startPointer.y),
      };
    } else if (drag.handle === 'rotate') {
      session.rotation = drag.startRotation + (this.angleFromPivot(pointer) - drag.startAngle);
    } else {
      this.updateScaleDrag(drag, session, pointer);
    }

    this.engine.updateFloatingTransform(this.matrix());
    return true;
  }

  endDrag(pointerId: number): void {
    if (this.drag?.pointerId === pointerId) this.drag = null;
  }

  /**
   * Corner scaling, measured in the box's *un-rotated* frame: the pointer is mapped back
   * through the current transform first, so dragging a corner of a rotated box still
   * stretches along that box's own axes rather than the screen's.
   */
  private updateScaleDrag(
    drag: NonNullable<TransformTool['drag']>,
    session: TransformSession,
    pointer: Point,
  ): void {
    const pivot = this.pivot;
    const inverse = invert(
      composeAround(pivot, drag.startTranslate, { x: 1, y: 1 }, drag.startRotation),
    );
    if (!inverse) return;

    const local = apply(inverse, pointer);
    const startLocal = apply(inverse, drag.startPointer);

    const halfWidth = session.source.width / 2;
    const halfHeight = session.source.height / 2;
    if (halfWidth === 0 || halfHeight === 0) return;

    const signX = drag.handle === 'ne' || drag.handle === 'se' ? 1 : -1;
    const signY = drag.handle === 'sw' || drag.handle === 'se' ? 1 : -1;

    const startOffsetX = (startLocal.x - pivot.x) * signX;
    const startOffsetY = (startLocal.y - pivot.y) * signY;
    const offsetX = (local.x - pivot.x) * signX;
    const offsetY = (local.y - pivot.y) * signY;

    // Guard against the degenerate case of grabbing exactly at the pivot.
    const ratioX = Math.abs(startOffsetX) < 1 ? 1 : offsetX / startOffsetX;
    const ratioY = Math.abs(startOffsetY) < 1 ? 1 : offsetY / startOffsetY;

    session.scale = {
      x: clampScale(drag.startScale.x * ratioX),
      y: clampScale(drag.startScale.y * ratioY),
    };
  }

  private angleFromPivot(point: Point): number {
    const pivot = this.pivot;
    return Math.atan2(point.y - pivot.y, point.x - pivot.x);
  }
}

/** Keeps a flipped or collapsed box usable rather than letting it invert to nothing. */
function clampScale(value: number): number {
  const magnitude = Math.min(20, Math.max(0.02, Math.abs(value)));
  return value < 0 ? -magnitude : magnitude;
}

/** Tight bounds of everything non-transparent, for transforming a whole layer. */
function usedBounds(image: ImageData): Rect | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    const row = y * image.width;
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(row + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
