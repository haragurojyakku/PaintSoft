import type { Mat3 } from '../core/mat3';
import type { LayerBlendMode } from './blendModes';
import { Compositor, type Rect } from './gl/Compositor';
import { LayerBlender } from './gl/LayerBlender';
import { RenderTarget } from './gl/RenderTarget';
import { SelectionOverlay } from './gl/SelectionOverlay';
import { AIRBRUSH_SPREAD, StampBatch } from './gl/StampBatch';
import type { StampBounds, StampBuffer } from './StampBuffer';

export interface EngineLayer {
  readonly id: number;
  target: RenderTarget;
  /**
   * Optional greyscale mask. Its red channel scales the layer's alpha at composite time,
   * so white reveals and black hides. Stored as a full RGBA target rather than R8 because
   * it is painted through the very same stroke pipeline as the layer itself.
   */
  mask: RenderTarget | null;
}

/** Which of a layer's two buffers a stroke lands on. */
export type StrokeTarget = 'color' | 'mask';

/**
 * What to composite, bottom-to-top. Visibility and opacity live here rather than on the
 * layer itself so the document model stays the single source of truth: a hidden node is
 * simply absent from the tree, and a folder's opacity applies to its subtree as a unit.
 */
export type RenderNode =
  | { kind: 'layer'; layerId: number; opacity: number; blend: LayerBlendMode }
  | { kind: 'group'; opacity: number; blend: LayerBlendMode; children: RenderNode[] }
  /**
   * A clipping group: `members` are drawn over `base` but limited to `base`'s alpha, and
   * the whole stack then composites with `base`'s own opacity and blend mode.
   */
  | { kind: 'clip'; base: RenderNode; members: RenderNode[] };

export interface StrokeStyle {
  color: readonly [number, number, number];
  blur: number;
  buildup: boolean;
  erase: boolean;
}

export interface ViewState {
  /** Offset from centred, in CSS pixels. */
  panX: number;
  panY: number;
  zoom: number;
}

export interface RenderStats {
  /** Wall time of the last frame that actually did work, in milliseconds. */
  frameMs: number;
  stampsLastFrame: number;
  strokeStamps: number;
  compositedLayers: number;
}

interface ActiveStroke {
  layerId: number;
  target: StrokeTarget;
  style: StrokeStyle;
  /** Region stamped since the last composite — the only part of the preview that needs redoing. */
  frameDirty: StampBounds | null;
  /** Region stamped over the whole stroke, used to scope the undo snapshot at commit time. */
  totalDirty: StampBounds | null;
  stampCount: number;
}

/**
 * Owns the WebGL2 context and every pixel buffer in the app: one texture per layer, the
 * in-progress stroke buffer, the layer+stroke preview, and the composited document.
 *
 * Two decisions here are what fix v1's scaling problems:
 *
 *  1. **Nothing draws synchronously from an input event.** Pointer handlers only append
 *     stamps and set a dirty flag; all GPU work happens once per animation frame. v1 ran a
 *     full-canvas clear-and-recomposite inside every `pointermove`, so a single stroke could
 *     trigger dozens of whole-canvas redraws per frame.
 *
 *  2. **Per-frame work is scoped to the region the brush touched.** The stroke preview is
 *     rebuilt only inside the current dirty rect, so brush size drives GPU fill rate rather
 *     than the number of full-canvas passes.
 */
export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;

  private readonly compositor: Compositor;
  private readonly stampBatch: StampBatch;
  private readonly layerBlender: LayerBlender;
  private readonly selectionOverlay: SelectionOverlay;

  /** R8 coverage texture mirroring the CPU-side Selection, or null when nothing is selected. */
  private selectionTexture: WebGLTexture | null = null;

  /**
   * Pixels lifted out of a layer and being transformed. They composite on top of their
   * origin layer under the given matrix until the edit is committed or cancelled, so the
   * source pixels are only ever resampled once — at commit — rather than on every drag.
   */
  private floating: { layerId: number; target: RenderTarget; transform: Mat3 } | null = null;

  private documentWidth: number;
  private documentHeight: number;

  private documentTarget: RenderTarget;
  private strokeBuffer: RenderTarget;
  private strokeScratch: RenderTarget;

  private readonly layers = new Map<number, EngineLayer>();
  private renderTree: RenderNode[] = [];
  private nextLayerId = 1;

  /** Reusable full-size targets for folders that need real group compositing. */
  private readonly groupPool: RenderTarget[] = [];

  private stroke: ActiveStroke | null = null;

  private view: ViewState = { panX: 0, panY: 0, zoom: 1 };
  private backgroundColor: [number, number, number] = [1, 1, 1];

  private needsComposite = true;
  private needsPresent = true;
  private documentTextureDirty = true;

  private rafHandle = 0;
  private stats: RenderStats = { frameMs: 0, stampsLastFrame: 0, strokeStamps: 0, compositedLayers: 0 };

  constructor(canvas: HTMLCanvasElement, documentWidth: number, documentHeight: number) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // Lets the compositor skip a frame of latency between our draw and the pixels
      // reaching the screen. Meaningful for pen input, where the gap between nib and
      // ink is the single most noticeable quality-of-feel property.
      desynchronized: true,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error('WebGL2 is not available in this browser.');
    }

    this.gl = gl;
    this.documentWidth = documentWidth;
    this.documentHeight = documentHeight;

    this.compositor = new Compositor(gl);
    this.stampBatch = new StampBatch(gl);
    this.layerBlender = new LayerBlender(gl);
    this.selectionOverlay = new SelectionOverlay(gl);

    this.documentTarget = new RenderTarget(gl, documentWidth, documentHeight);
    this.strokeBuffer = new RenderTarget(gl, documentWidth, documentHeight);
    this.strokeScratch = new RenderTarget(gl, documentWidth, documentHeight);
  }

  // ---------------------------------------------------------------- document

  get width(): number {
    return this.documentWidth;
  }

  get height(): number {
    return this.documentHeight;
  }

  getStats(): Readonly<RenderStats> {
    return this.stats;
  }

  setBackgroundColor(color: readonly [number, number, number]): void {
    this.backgroundColor = [color[0], color[1], color[2]];
    this.invalidate();
  }

  // ------------------------------------------------------------------ layers

  createLayer(): EngineLayer {
    const layer: EngineLayer = {
      id: this.nextLayerId++,
      target: new RenderTarget(this.gl, this.documentWidth, this.documentHeight),
      mask: null,
    };
    layer.target.clear();
    this.layers.set(layer.id, layer);
    this.invalidate();
    return layer;
  }

  getLayer(id: number): EngineLayer | undefined {
    return this.layers.get(id);
  }

  deleteLayer(id: number): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.target.dispose();
    layer.mask?.dispose();
    this.layers.delete(id);
    if (this.stroke?.layerId === id) this.cancelStroke();
    this.invalidate();
  }

  /**
   * Attaches a mask. 'reveal' starts fully white (nothing hidden), 'hide' fully black —
   * the two starting points every editor offers, corresponding to "mask what I paint" and
   * "reveal what I paint".
   */
  createLayerMask(id: number, initial: 'reveal' | 'hide' = 'reveal'): void {
    const layer = this.layers.get(id);
    if (!layer || layer.mask) return;

    layer.mask = new RenderTarget(this.gl, this.documentWidth, this.documentHeight);
    const value = initial === 'reveal' ? 1 : 0;
    layer.mask.clear(value, value, value, 1);
    this.invalidate();
  }

  deleteLayerMask(id: number): void {
    const layer = this.layers.get(id);
    if (!layer?.mask) return;

    if (this.stroke?.layerId === id && this.stroke.target === 'mask') this.cancelStroke();
    layer.mask.dispose();
    layer.mask = null;
    this.invalidate();
  }

  hasMask(id: number): boolean {
    return this.layers.get(id)?.mask != null;
  }

  uploadLayerMask(id: number, source: TexImageSource): void {
    const layer = this.layers.get(id);
    if (!layer?.mask) return;

    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, layer.mask.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.invalidate();
  }

  /** A mask's pixels, opaque greyscale, row 0 = document top. */
  exportLayerMaskImageData(id: number): ImageData | null {
    const mask = this.layers.get(id)?.mask;
    if (!mask) return null;
    // Masks are stored opaque, so the premultiplied bytes are already the values wanted.
    const pixels = mask.readPixels();
    return new ImageData(new Uint8ClampedArray(pixels), mask.width, mask.height);
  }

  /** Replaces what gets composited. Bottom-to-top; see RenderNode. */
  setRenderTree(tree: RenderNode[]): void {
    this.renderTree = tree;
    this.invalidate();
  }

  /**
   * Mirrors the CPU-side selection into a single-channel texture, or clears it when `mask`
   * is null. Everything that confines drawing to the selection reads this texture.
   */
  setSelectionMask(mask: Uint8Array | null): void {
    const { gl } = this;

    if (!mask) {
      if (this.selectionTexture) gl.deleteTexture(this.selectionTexture);
      this.selectionTexture = null;
      this.invalidate();
      return;
    }

    if (!this.selectionTexture) {
      this.selectionTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.selectionTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.selectionTexture);
    }

    // Single byte per pixel, so the default 4-byte row alignment has to be relaxed or rows
    // whose width is not a multiple of four would be read with padding that is not there.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.documentWidth,
      this.documentHeight,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      mask,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this.invalidate();
  }

  get hasSelection(): boolean {
    return this.selectionTexture !== null;
  }

  // ---------------------------------------------------------------- floating

  /** Builds a document-sized target from decoded pixels. Caller owns the result. */
  createTargetFromImage(image: ImageData): RenderTarget {
    const target = new RenderTarget(this.gl, this.documentWidth, this.documentHeight);
    target.clear();

    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    return target;
  }

  setFloating(layerId: number, target: RenderTarget, transform: Mat3): void {
    this.floating = { layerId, target, transform };
    this.invalidate();
  }

  updateFloatingTransform(transform: Mat3): void {
    if (!this.floating) return;
    this.floating.transform = transform;
    this.invalidate();
  }

  /** Detaches the floating pixels without merging them. Caller still owns the target. */
  clearFloating(): void {
    this.floating = null;
    this.invalidate();
  }

  /** Bakes the floating pixels into their layer under the current transform. */
  commitFloating(): void {
    const floating = this.floating;
    if (!floating) return;

    const layer = this.layers.get(floating.layerId);
    if (layer) {
      this.compositor.draw(layer.target, floating.target.texture, {
        transform: floating.transform,
        smooth: true,
      });
    }

    this.floating = null;
    this.invalidate();
  }

  /** Frees every layer buffer — for loading a project over the current one. */
  resetLayers(): void {
    this.cancelStroke();
    for (const layer of this.layers.values()) layer.target.dispose();
    this.layers.clear();
    this.renderTree = [];
    this.invalidate();
  }

  clearLayer(id: number): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.target.clear();
    this.invalidate();
  }

  /**
   * Replaces a layer's pixels from a decoded image (or any TexImageSource).
   *
   * The source is un-premultiplied — that is what a PNG holds — so the unpack conversion
   * is switched on for this upload only, keeping every texture in the engine premultiplied
   * as the compositor expects. Row 0 of the image lands on texel row 0, which is document
   * Y 0, so no flip is involved.
   */
  uploadLayerImage(id: number, source: TexImageSource): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, layer.target.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, layer.target.width, layer.target.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    this.invalidate();
  }

  /**
   * Colour of one composited document pixel as '#rrggbb', or null outside the canvas.
   * Reads back a single pixel, so it is cheap enough to call per eyedropper click.
   */
  sampleColor(x: number, y: number): string | null {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.documentWidth || py >= this.documentHeight) return null;

    if (this.needsComposite) {
      this.updateStrokePreview();
      this.composite();
      this.needsComposite = false;
      this.documentTextureDirty = true;
    }

    const { gl } = this;
    const pixel = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.documentTarget.framebuffer);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    // The document target is cleared to an opaque background, so alpha is always 255 here
    // and the premultiplied channels are already the displayed colour.
    const hex = (value: number) => value.toString(16).padStart(2, '0');
    return `#${hex(pixel[0]!)}${hex(pixel[1]!)}${hex(pixel[2]!)}`;
  }

  /** A single layer's pixels as un-premultiplied RGBA, row 0 = document top. */
  exportLayerImageData(id: number): ImageData | null {
    const layer = this.layers.get(id);
    if (!layer) return null;
    return toImageData(layer.target.readPixels(), layer.target.width, layer.target.height);
  }

  /**
   * Changes the document's pixel dimensions, carrying every layer's contents across.
   *
   * 'scale' resamples the artwork to the new size (画像解像度 in other editors); 'crop'
   * keeps it at its original scale and changes only the canvas extents, positioning the
   * old artwork by a 0..1 anchor (カンバスサイズ).
   */
  resizeDocument(
    width: number,
    height: number,
    options: { mode?: 'scale' | 'crop'; anchorX?: number; anchorY?: number } = {},
  ): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.documentWidth && nextHeight === this.documentHeight) return;

    const { mode = 'scale', anchorX = 0.5, anchorY = 0.5 } = options;
    this.cancelStroke();

    const placement: Rect =
      mode === 'scale'
        ? { x: 0, y: 0, width: nextWidth, height: nextHeight }
        : {
            x: Math.round((nextWidth - this.documentWidth) * anchorX),
            y: Math.round((nextHeight - this.documentHeight) * anchorY),
            width: this.documentWidth,
            height: this.documentHeight,
          };

    for (const layer of this.layers.values()) {
      const resized = new RenderTarget(this.gl, nextWidth, nextHeight);
      resized.clear();
      this.compositor.draw(resized, layer.target.texture, { rect: placement, smooth: true });
      layer.target.dispose();
      layer.target = resized;
    }

    this.documentWidth = nextWidth;
    this.documentHeight = nextHeight;

    for (const target of [this.documentTarget, this.strokeBuffer, this.strokeScratch, ...this.groupPool]) {
      target.resize(nextWidth, nextHeight);
    }

    this.invalidate();
  }

  // ------------------------------------------------------------------ stroke

  beginStroke(layerId: number, style: StrokeStyle, target: StrokeTarget = 'color'): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    if (target === 'mask' && !layer.mask) return;

    const destination = target === 'mask' ? layer.mask! : layer.target;

    this.strokeBuffer.clear();
    // One full-canvas copy per stroke seeds the preview; from here on only the dirty
    // rect is refreshed, so the per-frame cost no longer depends on canvas size. The same
    // scratch serves both buffers — only one stroke is ever in flight.
    this.compositor.copy(this.strokeScratch, destination.texture);

    this.stroke = { layerId, target, style, frameDirty: null, totalDirty: null, stampCount: 0 };
  }

  /** The buffer the in-flight stroke will be flattened into. */
  private strokeDestination(stroke: ActiveStroke): RenderTarget | null {
    const layer = this.layers.get(stroke.layerId);
    if (!layer) return null;
    return stroke.target === 'mask' ? layer.mask : layer.target;
  }

  /**
   * Rasterises everything currently in `stamps` into the stroke buffer. The caller resets
   * the buffer afterwards; stamps already committed here stay in the stroke buffer.
   */
  addStamps(stamps: StampBuffer): void {
    const stroke = this.stroke;
    if (!stroke || stamps.isEmpty) return;

    const bounds = stamps.bounds(blurSpread(stroke.style.blur), 1);
    if (!bounds) return;

    this.stampBatch.draw(this.strokeBuffer, stamps.data, stamps.count, {
      color: stroke.style.color,
      blur: stroke.style.blur,
      buildup: stroke.style.buildup,
    });

    stroke.stampCount += stamps.count;
    stroke.frameDirty = unionBounds(stroke.frameDirty, bounds);
    stroke.totalDirty = unionBounds(stroke.totalDirty, bounds);

    this.stats.strokeStamps = stroke.stampCount;
    this.invalidate();
  }

  /**
   * Flattens the stroke buffer into its layer.
   *
   * Returns the region the stroke touched so the history layer can snapshot just that
   * rect — callers that want undo must capture it *before* calling this, while the layer
   * still holds its pre-stroke pixels.
   */
  endStroke(): Rect | null {
    const stroke = this.stroke;
    if (!stroke) return null;

    const destination = this.strokeDestination(stroke);
    const rect = stroke.totalDirty ? boundsToRect(stroke.totalDirty) : null;

    if (destination && rect) {
      this.compositor.draw(destination, this.strokeBuffer.texture, {
        blend: stroke.style.erase ? 'erase' : 'normal',
        scissor: rect,
        coverageMask: this.selectionTexture ?? undefined,
      });
    }

    this.stroke = null;
    this.stats.strokeStamps = 0;
    this.invalidate();
    return rect;
  }

  cancelStroke(): void {
    if (!this.stroke) return;
    this.stroke = null;
    this.stats.strokeStamps = 0;
    this.invalidate();
  }

  /** The region the in-progress stroke has touched so far, for pre-commit undo capture. */
  getStrokeRect(): Rect | null {
    return this.stroke?.totalDirty ? boundsToRect(this.stroke.totalDirty) : null;
  }

  // ------------------------------------------------------------------- undo

  /**
   * GPU-side copy of a rect of a layer, used as an undo record. Caller owns the result.
   *
   * Returns the rect actually captured, which is `rect` clipped to the document — pass
   * *that* back to `restoreRegion`, since a stroke that ran off the edge of the canvas
   * produces a request rect whose origin sits outside it.
   */
  snapshotRegion(
    layerId: number,
    rect: Rect,
    target: StrokeTarget = 'color',
  ): { target: RenderTarget; rect: Rect } | null {
    const layer = this.layers.get(layerId);
    const source = target === 'mask' ? layer?.mask : layer?.target;
    if (!source) return null;

    const clipped = clipRect(rect, this.documentWidth, this.documentHeight);
    if (!clipped) return null;

    const snapshot = new RenderTarget(this.gl, clipped.width, clipped.height);
    this.compositor.draw(snapshot, source.texture, {
      blend: 'replace',
      // Positioning the full-size source so that `clipped` lands at the snapshot's origin.
      rect: {
        x: -clipped.x,
        y: -clipped.y,
        width: this.documentWidth,
        height: this.documentHeight,
      },
    });
    return { target: snapshot, rect: clipped };
  }

  restoreRegion(
    layerId: number,
    snapshot: RenderTarget,
    rect: Rect,
    target: StrokeTarget = 'color',
  ): void {
    const layer = this.layers.get(layerId);
    const destination = target === 'mask' ? layer?.mask : layer?.target;
    if (!destination) return;

    this.compositor.draw(destination, snapshot.texture, {
      blend: 'replace',
      rect: { x: rect.x, y: rect.y, width: snapshot.width, height: snapshot.height },
    });
    this.invalidate();
  }

  // -------------------------------------------------------------------- view

  setView(view: Partial<ViewState>): void {
    this.view = { ...this.view, ...view };
    this.needsPresent = true;
    this.requestFrame();
  }

  getView(): Readonly<ViewState> {
    return this.view;
  }

  /** Document pixels per CSS pixel — v1's getCanvasPixelScale(). */
  get pixelScale(): number {
    return 1 / this.view.zoom;
  }

  screenToDocument(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    const displayWidth = this.documentWidth * this.view.zoom;
    const displayHeight = this.documentHeight * this.view.zoom;
    const originX = (bounds.width - displayWidth) / 2 + this.view.panX;
    const originY = (bounds.height - displayHeight) / 2 + this.view.panY;

    return {
      x: (clientX - bounds.left - originX) / this.view.zoom,
      y: (clientY - bounds.top - originY) / this.view.zoom,
    };
  }

  // ------------------------------------------------------------------ frames

  invalidate(): void {
    this.needsComposite = true;
    this.needsPresent = true;
    this.requestFrame();
  }

  start(): void {
    this.requestFrame();
  }

  stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private requestFrame(): void {
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    const resized = this.syncCanvasSize();
    if (!this.needsComposite && !this.needsPresent && !resized) return;

    const started = performance.now();

    if (this.needsComposite) {
      this.updateStrokePreview();
      this.composite();
      this.needsComposite = false;
      this.documentTextureDirty = true;
    }

    this.present();
    this.needsPresent = false;

    this.stats.frameMs = performance.now() - started;
  }

  /**
   * Refreshes the layer+stroke preview inside the region stamped since the last frame:
   * re-copy the untouched layer there, then lay the accumulated stroke over it. Regions
   * stamped in earlier frames are already correct and are left alone.
   */
  private updateStrokePreview(): void {
    const stroke = this.stroke;
    if (!stroke || !stroke.frameDirty) return;

    const destination = this.strokeDestination(stroke);
    if (!destination) return;

    const scissor = boundsToRect(stroke.frameDirty);
    this.compositor.draw(this.strokeScratch, destination.texture, { blend: 'replace', scissor });
    this.compositor.draw(this.strokeScratch, this.strokeBuffer.texture, {
      blend: stroke.style.erase ? 'erase' : 'normal',
      scissor,
      // Applied to the preview as well as the commit, so what the canvas shows mid-stroke
      // is exactly what will be kept.
      coverageMask: this.selectionTexture ?? undefined,
    });

    stroke.frameDirty = null;
  }

  private composite(): void {
    const [r, g, b] = this.backgroundColor;
    this.documentTarget.clear(r, g, b, 1);
    this.stats.compositedLayers = 0;

    const result = this.drawNodes(this.documentTarget, this.renderTree);
    if (result !== this.documentTarget) {
      // A blend-mode pass leaves its output in a scratch target; fold it back so the
      // document texture (which present/export both read) stays the single result buffer.
      this.compositor.copy(this.documentTarget, result.texture);
      this.releaseTarget(result);
    }
  }

  /**
   * Draws `nodes` over `target` and returns whichever target actually holds the result.
   *
   * 'normal' nodes blend straight into the current surface with fixed-function blending.
   * Any other mode has to *read* the backdrop, which a shader cannot do from the surface
   * it is writing to, so those ping-pong into a scratch target which then becomes the new
   * current one.
   *
   * Ownership contract: the returned target contains `target`'s original contents plus
   * every node drawn. If it is not `target` itself it is a pooled scratch that the caller
   * must release; this method never releases `target`.
   */
  private drawNodes(target: RenderTarget, nodes: readonly RenderNode[]): RenderTarget {
    let current = target;

    const advanceTo = (next: RenderTarget) => {
      if (current !== target) this.releaseTarget(current);
      current = next;
    };

    for (const node of nodes) {
      if (node.kind === 'clip') {
        const flattened = this.renderClipGroup(node);
        if (!flattened) continue;

        const opacity = nodeOpacity(node.base);
        const blend = nodeBlend(node.base);
        if (blend === 'normal') {
          this.compositor.draw(current, flattened.texture, { opacity });
        } else {
          const next = this.acquireTarget();
          this.layerBlender.draw(next, current.texture, flattened.texture, blend, opacity);
          advanceTo(next);
        }
        this.releaseTarget(flattened);
        continue;
      }

      if (node.opacity <= 0) continue;

      // A fully opaque group in normal mode composites identically to its children drawn
      // straight into the parent, so the common case skips the intermediate entirely.
      // Note this returns the *whole* composite (backdrop included), which is why it
      // replaces `current` rather than being drawn over it.
      if (node.kind === 'group' && node.opacity >= 1 && node.blend === 'normal') {
        const result = this.drawNodes(current, node.children);
        if (result !== current) advanceTo(result);
        continue;
      }

      // Everything else needs the node as a standalone texture to composite from.
      let source: RenderTarget;
      let ownsSource = false;

      if (node.kind === 'layer') {
        const layer = this.layers.get(node.layerId);
        if (!layer) continue;

        const painting = this.stroke?.layerId === node.layerId ? this.stroke.target : null;

        // The layer being drawn on shows its preview (layer + uncommitted stroke); when the
        // stroke is going to the mask instead, the colour buffer is untouched and it is the
        // mask that comes from the scratch.
        let pixels = painting === 'color' ? this.strokeScratch : layer.target;
        const maskTexture =
          painting === 'mask' ? this.strokeScratch.texture : (layer.mask?.texture ?? null);

        if (this.floating?.layerId === node.layerId) {
          // Layer plus the floating pixels under their live transform, so the layer's own
          // opacity, mask and blend mode still apply to the pair as one thing.
          const scratch = this.acquireTarget();
          this.compositor.draw(scratch, pixels.texture, { blend: 'replace' });
          this.compositor.draw(scratch, this.floating.target.texture, {
            transform: this.floating.transform,
            smooth: true,
          });
          pixels = scratch;
          ownsSource = true;
        }

        if (maskTexture) {
          // Baking the mask into a scratch here — rather than passing it further down —
          // means everything downstream (blend modes, clipping, groups) keeps working on a
          // plain texture and needs to know nothing about masks.
          const masked = this.acquireTarget();
          this.compositor.draw(masked, pixels.texture, { blend: 'replace', coverageMask: maskTexture });
          if (ownsSource) this.releaseTarget(pixels);
          pixels = masked;
          ownsSource = true;
        }

        source = pixels;
        this.stats.compositedLayers += 1;
      } else {
        const scratch = this.acquireTarget();
        scratch.clear();
        const result = this.drawNodes(scratch, node.children);
        if (result !== scratch) this.releaseTarget(scratch);
        source = result;
        ownsSource = true;
      }

      if (node.blend === 'normal') {
        this.compositor.draw(current, source.texture, { opacity: node.opacity });
      } else {
        // The blender writes every pixel of its destination, so no clear is needed here.
        const next = this.acquireTarget();
        this.layerBlender.draw(next, current.texture, source.texture, node.blend, node.opacity);
        advanceTo(next);
      }

      if (ownsSource) this.releaseTarget(source);
    }

    return current;
  }

  /**
   * Flattens a clipping group into a single target the caller must release.
   *
   * The base is drawn first and doubles as the mask: every member is composited on top with
   * its alpha scaled by the base's, so nothing escapes the base's silhouette. Members keep
   * their own blend modes, which resolve against the accumulating group content rather than
   * against what lies beneath the group — that separation is the whole point of clipping.
   *
   * Note the base is drawn at full opacity here; its opacity and blend mode apply once, to
   * the finished group, so a semi-transparent base does not also fade the layers clipped to it.
   */
  private renderClipGroup(node: Extract<RenderNode, { kind: 'clip' }>): RenderTarget | null {
    const baseTarget = this.acquireTarget();
    baseTarget.clear();

    const baseResult = this.drawNodes(baseTarget, [withFullOpacityNormal(node.base)]);
    if (baseResult !== baseTarget) this.releaseTarget(baseTarget);

    // baseResult doubles as the mask for every member, so it must stay out of the pool
    // until the loop is done — releasing it early would let the next acquire hand the same
    // target back and clear the silhouette mid-flight.
    let current = baseResult;
    for (const member of node.members) {
      const memberTarget = this.acquireTarget();
      memberTarget.clear();
      const memberResult = this.drawNodes(memberTarget, [withFullOpacityNormal(member)]);
      if (memberResult !== memberTarget) this.releaseTarget(memberTarget);

      const next = this.acquireTarget();
      this.layerBlender.draw(
        next,
        current.texture,
        memberResult.texture,
        nodeBlend(member),
        nodeOpacity(member),
        baseResult.texture,
      );
      this.releaseTarget(memberResult);
      if (current !== baseResult) this.releaseTarget(current);
      current = next;
    }

    if (current !== baseResult) this.releaseTarget(baseResult);
    return current;
  }

  private acquireTarget(): RenderTarget {
    return this.groupPool.pop() ?? new RenderTarget(this.gl, this.documentWidth, this.documentHeight);
  }

  private releaseTarget(target: RenderTarget): void {
    this.groupPool.push(target);
  }

  private present(): void {
    const { gl } = this;
    const ratio = window.devicePixelRatio || 1;
    const scale = this.view.zoom * ratio;

    const displayWidth = this.documentWidth * scale;
    const displayHeight = this.documentHeight * scale;
    const rect: Rect = {
      x: (this.canvas.width - displayWidth) / 2 + this.view.panX * ratio,
      y: (this.canvas.height - displayHeight) / 2 + this.view.panY * ratio,
      width: displayWidth,
      height: displayHeight,
    };

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.11, 0.11, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Minified views sample a mip chain so a heavily zoomed-out canvas stays smooth
    // instead of shimmering; magnified views switch to NEAREST so individual document
    // pixels stay crisp past 1:1, matching v1's zoom behaviour.
    const minifying = scale < 1;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.documentTarget.texture);
    if (minifying) {
      if (this.documentTextureDirty) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    this.documentTextureDirty = false;

    const screen = { framebuffer: null, width: this.canvas.width, height: this.canvas.height };
    this.compositor.draw(screen, this.documentTarget.texture, { rect, smooth: scale < 1.5 });

    if (this.selectionTexture) {
      this.selectionOverlay.draw(
        screen,
        this.selectionTexture,
        rect,
        this.documentWidth,
        this.documentHeight,
      );
    }
  }

  /** Returns true when the backing store size changed and a redraw is therefore required. */
  private syncCanvasSize(): boolean {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));

    if (this.canvas.width === width && this.canvas.height === height) return false;

    this.canvas.width = width;
    this.canvas.height = height;
    this.needsPresent = true;
    return true;
  }

  // ------------------------------------------------------------------ export

  /** Composited document as un-premultiplied RGBA, row 0 = document top. */
  exportImageData(): ImageData {
    if (this.needsComposite) {
      this.updateStrokePreview();
      this.composite();
      this.needsComposite = false;
    }

    return toImageData(this.documentTarget.readPixels(), this.documentWidth, this.documentHeight);
  }

  dispose(): void {
    this.stop();
    for (const layer of this.layers.values()) layer.target.dispose();
    this.layers.clear();
    for (const target of this.groupPool) target.dispose();
    this.groupPool.length = 0;
    this.documentTarget.dispose();
    this.strokeBuffer.dispose();
    this.strokeScratch.dispose();
    if (this.selectionTexture) this.gl.deleteTexture(this.selectionTexture);
    this.compositor.dispose();
    this.stampBatch.dispose();
    this.layerBlender.dispose();
    this.selectionOverlay.dispose();
  }
}

/**
 * Undoes the premultiplication every engine texture stores, which is what PNG encoders
 * and PSD/.clip writers expect. Fully transparent pixels carry no recoverable colour, so
 * they are left as transparent black rather than divided by zero.
 */
function toImageData(premultiplied: Uint8Array, width: number, height: number): ImageData {
  const out = new Uint8ClampedArray(premultiplied.length);

  for (let i = 0; i < premultiplied.length; i += 4) {
    const alpha = premultiplied[i + 3]!;
    if (alpha === 0) continue;
    const inverse = 255 / alpha;
    out[i] = premultiplied[i]! * inverse;
    out[i + 1] = premultiplied[i + 1]! * inverse;
    out[i + 2] = premultiplied[i + 2]! * inverse;
    out[i + 3] = alpha;
  }

  return new ImageData(out, width, height);
}

function nodeOpacity(node: RenderNode): number {
  return node.kind === 'clip' ? nodeOpacity(node.base) : node.opacity;
}

function nodeBlend(node: RenderNode): LayerBlendMode {
  return node.kind === 'clip' ? nodeBlend(node.base) : node.blend;
}

/**
 * The same node stripped of its opacity and blend mode, for rendering its raw pixels into
 * a scratch target. Both are applied later, once, when the flattened result is composited.
 */
function withFullOpacityNormal(node: RenderNode): RenderNode {
  if (node.kind === 'clip') return node;
  return { ...node, opacity: 1, blend: 'normal' };
}

/** Outer-radius multiplier for a given blur — must match the stamp shader's uSpread. */
function blurSpread(blur: number): number {
  return 1 + (Math.max(0, Math.min(100, blur)) / 100) * AIRBRUSH_SPREAD;
}

function unionBounds(a: StampBounds | null, b: StampBounds): StampBounds {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function boundsToRect(bounds: StampBounds): Rect {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function clipRect(rect: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
