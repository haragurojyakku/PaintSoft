import type { Point } from '../core/Selection';
import type { HandleId, TransformTool } from './TransformTool';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CORNER_HANDLES: HandleId[] = ['nw', 'ne', 'se', 'sw'];

export interface TransformOverlayCallbacks {
  /** Maps a document point to a position within the overlay's own box. */
  documentToOverlay(point: Point): Point;
  onHandleDown(handle: HandleId, event: PointerEvent): void;
}

/**
 * The bounding box, corner handles and rotation handle for an in-progress transform.
 *
 * Drawn as SVG in screen space from document-space corners recomputed each frame, rather
 * than as a CSS-transformed element. That way the handles stay the same on-screen size at
 * any zoom and under any rotation — a CSS transform would scale and skew them along with
 * the box.
 */
export class TransformOverlay {
  private readonly svg: SVGSVGElement;
  private readonly outline: SVGPolygonElement;
  private readonly stem: SVGLineElement;
  private readonly handles = new Map<HandleId, SVGCircleElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly tool: TransformTool,
    private readonly callbacks: TransformOverlayCallbacks,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'transformOverlay');
    this.svg.setAttribute('hidden', '');

    this.outline = document.createElementNS(SVG_NS, 'polygon');
    this.outline.setAttribute('class', 'transformOutline');
    // The outline itself is the move handle, so dragging anywhere on the box moves it.
    this.outline.addEventListener('pointerdown', (event) => this.onDown('move', event));

    this.stem = document.createElementNS(SVG_NS, 'line');
    this.stem.setAttribute('class', 'transformStem');

    this.svg.append(this.outline, this.stem);

    for (const handle of [...CORNER_HANDLES, 'rotate' as const]) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', handle === 'rotate' ? 'transformRotate' : 'transformHandle');
      circle.setAttribute('r', handle === 'rotate' ? '7' : '6');
      circle.addEventListener('pointerdown', (event) => this.onDown(handle, event));
      this.handles.set(handle, circle);
      this.svg.append(circle);
    }

    this.root.append(this.svg);
  }

  private onDown(handle: HandleId, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onHandleDown(handle, event);
  }

  render(): void {
    const corners = this.tool.corners();
    if (corners.length !== 4) {
      this.svg.setAttribute('hidden', '');
      return;
    }
    this.svg.removeAttribute('hidden');

    const mapped = corners.map((corner) => this.callbacks.documentToOverlay(corner));
    this.outline.setAttribute('points', mapped.map((p) => `${p.x},${p.y}`).join(' '));

    CORNER_HANDLES.forEach((handle, index) => {
      const circle = this.handles.get(handle);
      const point = mapped[index];
      if (!circle || !point) return;
      circle.setAttribute('cx', String(point.x));
      circle.setAttribute('cy', String(point.y));
    });

    const rotatePoint = this.tool.rotationHandle();
    const rotateCircle = this.handles.get('rotate');
    if (rotatePoint && rotateCircle) {
      const mappedRotate = this.callbacks.documentToOverlay(rotatePoint);
      rotateCircle.setAttribute('cx', String(mappedRotate.x));
      rotateCircle.setAttribute('cy', String(mappedRotate.y));

      const topLeft = mapped[0]!;
      const topRight = mapped[1]!;
      this.stem.setAttribute('x1', String((topLeft.x + topRight.x) / 2));
      this.stem.setAttribute('y1', String((topLeft.y + topRight.y) / 2));
      this.stem.setAttribute('x2', String(mappedRotate.x));
      this.stem.setAttribute('y2', String(mappedRotate.y));
    }
  }

  hide(): void {
    this.svg.setAttribute('hidden', '');
  }
}
