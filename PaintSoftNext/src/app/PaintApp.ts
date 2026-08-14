import { PaintDocument, type NodeId } from '../core/Document';
import {
  cloneMask,
  eraseSelection,
  fillSelection,
  Selection,
  type Point,
  type SelectionMode,
} from '../core/Selection';
import { BLEND_MODES, BLEND_MODE_LABELS, isBlendMode } from '../engine/blendModes';
import { Engine, type StrokeStyle, type StrokeTarget } from '../engine/Engine';
import type { Rect } from '../engine/gl/Compositor';
import type { RenderTarget } from '../engine/gl/RenderTarget';
import { StampBuffer } from '../engine/StampBuffer';
import { StrokeBuilder, type BrushSettings, type SizeUnit } from '../engine/StrokeBuilder';
import {
  decodeLayerOntoCanvas,
  imageDataToPngDataUrl,
  type ClipDocumentDto,
} from '../io/clipBridge';
import { exportPsd } from '../io/psd';
import { loadProject, serializeProject } from '../io/psft';
import { floodFill } from '../tools/floodFill';
import { History } from './History';
import { LayerPanel } from './LayerPanel';
import { NodeEditor } from './NodeEditor';
import { TransformOverlay } from './TransformOverlay';
import { TransformTool, type HandleId } from './TransformTool';
import {
  bindingFromEvent,
  DEFAULT_SHORTCUTS,
  describeBinding,
  findConflicts,
  isModifierOnly,
  loadShortcuts,
  matchesBinding,
  saveShortcuts,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type ShortcutAction,
} from './shortcuts';
import {
  DEFAULT_BRUSH,
  loadBrush,
  loadGlobal,
  loadPresets,
  saveBrush,
  saveGlobal,
  savePresets,
  type BrushPreset,
  type GlobalSettings,
} from './settings';

type Tool =
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'selectRect'
  | 'selectLasso'
  | 'transform';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

export class PaintApp {
  /** Public so tests and the desktop shell's bridge can reach the renderer directly. */
  readonly engine: Engine;
  readonly doc = new PaintDocument();

  private readonly history: History;
  private readonly layerPanel: LayerPanel;
  private readonly nodeEditor: NodeEditor;
  private readonly strokeBuilder = new StrokeBuilder();
  private readonly stamps = new StampBuffer();

  private brush: BrushSettings = loadBrush();
  private global: GlobalSettings = loadGlobal();
  private presets: BrushPreset[] = loadPresets();
  private activePresetIndex = -1;

  private tool: Tool = 'brush';
  /** When true and the drawing layer has a mask, strokes edit the mask instead. */
  private maskEditing = false;
  private shortcuts = loadShortcuts();
  /** Suppresses the normal shortcut handler while the settings dialog is reading a key. */
  private capturingShortcut = false;

  readonly selection: Selection;
  private selectionDrag: {
    pointerId: number;
    mode: SelectionMode;
    start: Point;
    points: Point[];
  } | null = null;

  /** The mask as it stood before the current drag, so add/subtract replay from a fixed base. */
  private baseSelection: Uint8Array | null = null;

  private readonly transformTool: TransformTool;
  private readonly transformOverlay: TransformOverlay;
  /** Layer state captured before the pixels were lifted, so a committed transform is undoable. */
  private transformUndo: { layerId: number; rect: Rect; before: RenderTarget } | null = null;

  private strokePointerId: number | null = null;
  private pan: { pointerId: number; startX: number; startY: number; panX: number; panY: number } | null = null;
  private spaceHeld = false;
  /**
   * Ctrl+Space + drag left/right zooms the view, anchored on whatever document point sits
   * at the canvas panel's on-screen center when the drag starts — not the pointer, which
   * only sets the zoom curve's input. That matches v1: dragging right zooms in, left zooms
   * out, and the visible center stays put regardless of where in the panel the drag began.
   */
  private zoomDrag: { pointerId: number; startX: number; startZoom: number; anchorScreenX: number; anchorScreenY: number } | null = null;

  /** Pushes current state back into the DOM controls, e.g. after loading a preset. */
  private readonly controlSyncs: (() => void)[] = [];
  private canvasMode: 'scale' | 'crop' = 'scale';
  private canvasAnchor = { x: 0.5, y: 0.5 };

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, documentWidth: number, documentHeight: number) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, documentWidth, documentHeight);
    this.history = new History(this.engine);
    this.selection = new Selection(documentWidth, documentHeight);

    this.layerPanel = new LayerPanel(requireEl('layerList'), this.doc, {
      onSelect: (id) => this.selectNode(id),
      onChanged: () => this.afterTreeChange(),
    });

    this.nodeEditor = new NodeEditor(requireEl('nodeCanvas'), this.doc, {
      onSelect: (id) => this.selectNode(id),
      onChanged: () => this.afterTreeChange(),
    });

    this.transformTool = new TransformTool(this.engine);
    this.transformOverlay = new TransformOverlay(
      canvas.parentElement ?? document.body,
      this.transformTool,
      {
        documentToOverlay: (point) => this.documentToViewport(point),
        onHandleDown: (handle, event) => this.beginTransformDrag(handle, event),
      },
    );

    this.addLayer('レイヤー 1');
    this.engine.setBackgroundColor(hexToRgb(this.global.bgColor));
    this.engine.start();

    this.bindPointer();
    this.bindKeyboard();
    this.bindControls();
    this.bindCanvasDialog();
    this.bindShortcutDialog();
    this.syncControls();
    this.renderPresets();
    this.renderLayers();
    this.startStatsLoop();
  }

  // ------------------------------------------------------------------ layers

  private addLayer(name?: string): void {
    const engineLayer = this.engine.createLayer();
    const parentId = this.parentForInsert();
    this.doc.createLayer(engineLayer.id, name, parentId);
    this.afterTreeChange();
  }

  private addFolder(): void {
    this.doc.createFolder(undefined, this.parentForInsert());
    this.afterTreeChange();
  }

  /** New nodes land beside the selection, or inside it when a folder is selected. */
  private parentForInsert(): NodeId | null {
    const selected = this.doc.selectedId === null ? null : this.doc.nodes.get(this.doc.selectedId);
    if (!selected) return null;
    return selected.kind === 'folder' ? selected.id : selected.parentId;
  }

  private deleteActiveNode(): void {
    const id = this.doc.selectedId;
    if (id === null) return;

    // A floating transform points at a layer that may be about to disappear.
    this.cancelTransform();

    const freed = this.doc.remove(id);
    // Refuse to leave the document with nowhere to draw.
    if (this.doc.layerCount === 0) {
      const engineLayer = this.engine.createLayer();
      this.doc.createLayer(engineLayer.id, 'レイヤー 1', null);
    }
    for (const engineLayerId of freed) this.engine.deleteLayer(engineLayerId);
    this.afterTreeChange();
  }

  private selectNode(id: NodeId): void {
    this.doc.select(id);
    this.renderLayers();
  }

  private afterTreeChange(): void {
    this.syncRenderTree();
    this.renderLayers();
  }

  /** The list, the node view and the properties strip always describe the same selection. */
  private renderLayers(): void {
    this.layerPanel.render();
    this.syncLayerProperties();
    if (!requireEl('nodePanel').hidden) this.nodeEditor.render();
  }

  private syncRenderTree(): void {
    this.engine.setRenderTree(this.doc.buildRenderTree());
  }

  private activeEngineLayerId(): number | null {
    return this.doc.activeLayer?.engineLayerId ?? null;
  }

  // ----------------------------------------------------------------- strokes

  /** Where strokes land: the layer's pixels, or its mask when mask editing is on. */
  private strokeTarget(): StrokeTarget {
    const layerId = this.activeEngineLayerId();
    return this.maskEditing && layerId !== null && this.engine.hasMask(layerId) ? 'mask' : 'color';
  }

  private strokeStyle(): StrokeStyle {
    if (this.strokeTarget() === 'mask') {
      // A mask holds coverage, not colour, so the brush paints the picked colour's
      // luminance and the eraser paints white — i.e. "reveal again" — rather than
      // punching a hole in the mask, which would read as hiding.
      const [r, g, b] = hexToRgb(this.global.color);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const value = this.tool === 'eraser' ? 1 : luminance;
      return { color: [value, value, value], blur: this.brush.blur, buildup: false, erase: false };
    }

    return {
      color: hexToRgb(this.global.color),
      blur: this.brush.blur,
      buildup: this.brush.buildup,
      erase: this.tool === 'eraser',
    };
  }

  private pressureOf(event: PointerEvent): number {
    if (!this.global.pressureEnabled) return 1;
    // Mice and touch report a constant 0.5 (or 0), which would otherwise read as a
    // permanent half-pressure stroke — only a pen carries a real pressure signal.
    if (event.pointerType !== 'pen') return 1;
    return Math.max(0.05, Math.min(1, event.pressure));
  }

  private beginStroke(event: PointerEvent): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;

    const point = this.engine.screenToDocument(event.clientX, event.clientY);
    this.engine.beginStroke(layerId, this.strokeStyle(), this.strokeTarget());
    this.strokeBuilder.begin(
      point.x,
      point.y,
      this.pressureOf(event),
      { brush: this.brush, stabilizer: this.global.stabilizer, pixelScale: this.engine.pixelScale },
      this.stamps,
    );
    this.flushStamps();
  }

  private extendStroke(event: PointerEvent): void {
    // A pen can report several hundred samples a second, far more than there are frames.
    // Draining the coalesced queue keeps every one of them feeding the stabiliser (so the
    // stroke stays smooth) while still doing all GPU work once per frame.
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length > 0 ? samples : [event]) {
      const point = this.engine.screenToDocument(sample.clientX, sample.clientY);
      this.strokeBuilder.move(point.x, point.y, this.pressureOf(sample), this.stamps);
    }
    this.flushStamps();
  }

  private endStroke(event: PointerEvent): void {
    const layerId = this.activeEngineLayerId();
    const target = this.strokeTarget();
    const point = this.engine.screenToDocument(event.clientX, event.clientY);
    this.strokeBuilder.end(point.x, point.y, this.pressureOf(event), this.stamps);
    this.flushStamps();

    // Captured while the layer still holds its pre-stroke pixels — endStroke() is what
    // flattens the stroke buffer into it.
    const rect = this.engine.getStrokeRect();
    const before =
      layerId !== null && rect ? this.engine.snapshotRegion(layerId, rect, target) : null;

    this.engine.endStroke();

    if (before && layerId !== null) {
      const after = this.engine.snapshotRegion(layerId, before.rect, target);
      if (after) this.history.record(layerId, before.rect, before.target, after.target, target);
      else before.target.dispose();
    }
    this.updateHistoryButtons();
  }

  private flushStamps(): void {
    if (this.stamps.isEmpty) return;
    this.engine.addStamps(this.stamps);
    this.stamps.reset();
  }

  /** Runs a layer edit with before/after snapshots so it lands on the undo stack. */
  private recordEdit(engineLayerId: number, rect: Rect, mutate: () => void): void {
    const before = this.engine.snapshotRegion(engineLayerId, rect);
    mutate();
    if (!before) return;

    const after = this.engine.snapshotRegion(engineLayerId, before.rect);
    if (after) this.history.record(engineLayerId, before.rect, before.target, after.target);
    else before.target.dispose();
    this.updateHistoryButtons();
  }

  private wholeCanvas(): Rect {
    return { x: 0, y: 0, width: this.engine.width, height: this.engine.height };
  }

  // ------------------------------------------------------------------- tools

  private applyBucket(event: PointerEvent): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;

    const point = this.engine.screenToDocument(event.clientX, event.clientY);
    const image = this.engine.exportLayerImageData(layerId);
    if (!image) return;

    const [r, g, b] = hexToRgb(this.global.color);
    const fill: [number, number, number] = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    if (!floodFill(image, point.x, point.y, fill, { selectionMask: this.selection.data })) {
      this.setHint('塗りつぶす範囲がありませんでした');
      return;
    }

    this.recordEdit(layerId, this.wholeCanvas(), () => this.engine.uploadLayerImage(layerId, image));
    this.setHint('塗りつぶしました');
  }

  private applyEyedropper(event: PointerEvent): void {
    const point = this.engine.screenToDocument(event.clientX, event.clientY);
    const sampled = this.engine.sampleColor(point.x, point.y);
    if (!sampled) return;

    this.global.color = sampled;
    saveGlobal(this.global);
    requireEl<HTMLInputElement>('color').value = sampled;
    this.setHint(`色を採取しました: ${sampled}`);
  }

  private clearActiveLayer(): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;
    this.recordEdit(layerId, this.wholeCanvas(), () => this.engine.clearLayer(layerId));
  }

  // --------------------------------------------------------------- selection

  /** Pushes the CPU-side mask to the GPU and refreshes anything that depends on it. */
  private commitSelection(): void {
    this.engine.setSelectionMask(this.selection.data);
    this.updateSelectionButtons();
  }

  /**
   * Called after anything that changes the canvas dimensions. A mask only means something
   * at the size it was built for, so `Selection.resize` drops it rather than leaving one
   * that no longer lines up with the artwork.
   */
  private resyncSelectionSize(): void {
    this.selection.resize(this.engine.width, this.engine.height);
    this.commitSelection();
  }

  /**
   * Puts any floating transform back before an operation that would invalidate it — the
   * floating buffer is sized to the old canvas and belongs to a layer that may be replaced.
   * Cancelling rather than committing keeps the pixels exactly where the file says they are.
   */
  private settleTransformBeforeStructuralChange(): void {
    this.cancelTransform();
  }

  private beginSelectionDrag(event: PointerEvent): void {
    const point = this.engine.screenToDocument(event.clientX, event.clientY);
    // Shift adds to the selection, Alt subtracts — the convention every editor shares.
    const mode: SelectionMode = event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace';

    this.selectionDrag = { pointerId: event.pointerId, mode, start: point, points: [point] };
    this.baseSelection = mode === 'replace' ? null : cloneMask(this.selection.data);
  }

  private updateSelectionDrag(event: PointerEvent): void {
    const drag = this.selectionDrag;
    if (!drag) return;

    const point = this.engine.screenToDocument(event.clientX, event.clientY);

    if (this.tool === 'selectLasso') {
      const last = drag.points[drag.points.length - 1]!;
      // Thinning the path keeps the per-frame polygon rasterisation proportional to the
      // shape's complexity rather than to how slowly the pointer was moved.
      if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
      drag.points.push(point);
    }

    this.applySelectionDrag(point);
  }

  private applySelectionDrag(point: Point): void {
    const drag = this.selectionDrag;
    if (!drag) return;

    // Each update replays from the pre-drag mask, so dragging back and forth adjusts one
    // shape instead of accumulating every intermediate one.
    this.restoreBaseSelection(drag.mode);

    if (this.tool === 'selectLasso') {
      this.selection.setPolygon(drag.points, drag.mode);
    } else {
      this.selection.setRect(
        {
          x: Math.min(drag.start.x, point.x),
          y: Math.min(drag.start.y, point.y),
          width: Math.abs(point.x - drag.start.x),
          height: Math.abs(point.y - drag.start.y),
        },
        drag.mode,
      );
    }

    this.commitSelection();
  }

  private restoreBaseSelection(mode: SelectionMode): void {
    if (mode === 'replace') {
      this.selection.deselect();
      return;
    }
    if (this.baseSelection) this.selection.setMask(cloneMask(this.baseSelection));
    else this.selection.deselect();
  }

  private endSelectionDrag(event: PointerEvent): void {
    const drag = this.selectionDrag;
    if (!drag) return;

    this.applySelectionDrag(this.engine.screenToDocument(event.clientX, event.clientY));
    this.selectionDrag = null;
    this.baseSelection = null;

    const bounds = this.selection.bounds();
    this.setHint(
      bounds
        ? `選択範囲: ${bounds.width}×${bounds.height} px`
        : '選択範囲がありません（クリックで解除されました）',
    );
  }

  private updateSelectionButtons(): void {
    const active = this.selection.isActive;
    for (const id of ['deselect', 'clearSelection', 'fillSelection']) {
      requireEl<HTMLButtonElement>(id).disabled = !active;
    }
  }

  /** Clears the selected pixels of the active layer. */
  private clearSelectedArea(): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;

    const rect = this.selection.bounds() ?? this.wholeCanvas();
    this.recordEdit(layerId, rect, () => {
      const image = this.engine.exportLayerImageData(layerId);
      if (!image) return;
      eraseSelection(image, this.selection);
      this.engine.uploadLayerImage(layerId, image);
    });
    this.setHint('選択範囲を消去しました');
  }

  /** Fills the selection with the current colour, respecting partial coverage at its edges. */
  private fillSelectedArea(): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;

    const rect = this.selection.bounds() ?? this.wholeCanvas();
    const [r, g, b] = hexToRgb(this.global.color);
    const color: [number, number, number] = [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255),
    ];

    this.recordEdit(layerId, rect, () => {
      const image = this.engine.exportLayerImageData(layerId);
      if (!image) return;
      fillSelection(image, this.selection, color);
      this.engine.uploadLayerImage(layerId, image);
    });
    this.setHint('選択範囲を塗りつぶしました');
  }

  // --------------------------------------------------------------- transform

  /** Document point to a position inside the viewport element the overlay lives in. */
  private documentToViewport(point: Point): Point {
    const canvasBounds = this.canvas.getBoundingClientRect();
    const parentBounds = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    const view = this.engine.getView();

    const originX = (canvasBounds.width - this.engine.width * view.zoom) / 2 + view.panX;
    const originY = (canvasBounds.height - this.engine.height * view.zoom) / 2 + view.panY;

    return {
      x: canvasBounds.left - parentBounds.left + originX + point.x * view.zoom,
      y: canvasBounds.top - parentBounds.top + originY + point.y * view.zoom,
    };
  }

  private beginTransform(): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null || this.transformTool.isActive) return;

    // Captured before the pixels are lifted, since lifting already modifies the layer.
    const rect = this.wholeCanvas();
    const before = this.engine.snapshotRegion(layerId, rect);

    const session = this.transformTool.begin(layerId, this.selection);
    if (!session) {
      before?.target.dispose();
      this.setHint('変形できる内容がありません');
      return;
    }

    this.transformUndo = before ? { layerId, rect: before.rect, before: before.target } : null;
    this.transformOverlay.render();
    this.setHint('ドラッグで移動 / 角で拡大縮小 / 上の丸で回転｜Enterで確定・Escapeで取消');
  }

  private beginTransformDrag(handle: HandleId, event: PointerEvent): void {
    if (!this.transformTool.isActive) return;

    const target = event.currentTarget as Element | null;
    target?.setPointerCapture?.(event.pointerId);
    this.transformTool.beginDrag(
      handle,
      event.pointerId,
      this.engine.screenToDocument(event.clientX, event.clientY),
    );

    const move = (moveEvent: PointerEvent) => {
      const point = this.engine.screenToDocument(moveEvent.clientX, moveEvent.clientY);
      if (this.transformTool.updateDrag(moveEvent.pointerId, point)) this.transformOverlay.render();
    };
    const end = (endEvent: PointerEvent) => {
      this.transformTool.endDrag(endEvent.pointerId);
      target?.removeEventListener('pointermove', move as EventListener);
      target?.removeEventListener('pointerup', end as EventListener);
      target?.removeEventListener('pointercancel', end as EventListener);
    };

    target?.addEventListener('pointermove', move as EventListener);
    target?.addEventListener('pointerup', end as EventListener);
    target?.addEventListener('pointercancel', end as EventListener);
  }

  private commitTransform(): void {
    if (!this.transformTool.isActive) return;

    this.transformTool.commit();
    this.transformOverlay.hide();
    this.finishTransformUndo('変形を確定しました');
  }

  private cancelTransform(): void {
    if (!this.transformTool.isActive) return;

    this.transformTool.cancel();
    this.transformOverlay.hide();
    // The pixels are back where they started, so there is nothing worth an undo entry.
    this.transformUndo?.before.dispose();
    this.transformUndo = null;
    this.setHint('変形を取り消しました');
  }

  private finishTransformUndo(message: string): void {
    const pending = this.transformUndo;
    this.transformUndo = null;
    if (!pending) return;

    const after = this.engine.snapshotRegion(pending.layerId, pending.rect);
    if (after) this.history.record(pending.layerId, pending.rect, pending.before, after.target);
    else pending.before.dispose();

    this.updateHistoryButtons();
    this.setHint(message);
  }

  // ------------------------------------------------------------------- input

  private bindPointer(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      // Checked ahead of the plain pan branch below (also gated on spaceHeld) so Ctrl adds
      // the zoom behaviour on top of whichever key currently triggers panning.
      if (event.ctrlKey && this.spaceHeld) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);

        const bounds = canvas.getBoundingClientRect();
        this.zoomDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startZoom: this.engine.getView().zoom,
          anchorScreenX: bounds.left + bounds.width / 2,
          anchorScreenY: bounds.top + bounds.height / 2,
        };
        this.setHint('ドラッグでズーム（左:縮小 / 右:拡大）');
        return;
      }

      if (event.button === 1 || this.spaceHeld) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('panning');
        const view = this.engine.getView();
        this.pan = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          panX: view.panX,
          panY: view.panY,
        };
        return;
      }

      if (event.button !== 0) return;

      if (this.tool === 'bucket') return this.applyBucket(event);
      if (this.tool === 'eyedropper') return this.applyEyedropper(event);

      if (this.tool === 'selectRect' || this.tool === 'selectLasso') {
        canvas.setPointerCapture(event.pointerId);
        this.beginSelectionDrag(event);
        return;
      }

      if (this.strokePointerId !== null) return;

      canvas.setPointerCapture(event.pointerId);
      this.strokePointerId = event.pointerId;
      this.beginStroke(event);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (this.zoomDrag && this.zoomDrag.pointerId === event.pointerId) {
        const dx = event.clientX - this.zoomDrag.startX;
        // Exponential curve: every 200px of drag doubles/halves the zoom, so the gesture
        // feels the same at any zoom level rather than slowing to a crawl once zoomed in.
        const zoom = this.zoomDrag.startZoom * Math.pow(2, dx / 200);
        this.zoomAroundScreenPoint(this.zoomDrag.anchorScreenX, this.zoomDrag.anchorScreenY, zoom);
        this.setHint(`ズーム: ${Math.round(this.engine.getView().zoom * 100)}%`);
        return;
      }

      if (this.pan && this.pan.pointerId === event.pointerId) {
        this.engine.setView({
          panX: this.pan.panX + (event.clientX - this.pan.startX),
          panY: this.pan.panY + (event.clientY - this.pan.startY),
        });
        return;
      }
      if (this.selectionDrag?.pointerId === event.pointerId) {
        this.updateSelectionDrag(event);
        return;
      }
      if (this.strokePointerId === event.pointerId) this.extendStroke(event);
    });

    const finish = (event: PointerEvent) => {
      if (this.zoomDrag && this.zoomDrag.pointerId === event.pointerId) {
        this.zoomDrag = null;
        this.setHint('ドラッグして描画 / Ctrl+Zで戻す / Ctrl+Yでやり直し');
        return;
      }
      if (this.pan && this.pan.pointerId === event.pointerId) {
        this.pan = null;
        canvas.classList.remove('panning');
        return;
      }
      if (this.selectionDrag?.pointerId === event.pointerId) {
        this.endSelectionDrag(event);
        return;
      }
      if (this.strokePointerId !== event.pointerId) return;
      this.strokePointerId = null;
      this.endStroke(event);
    };

    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.zoomAt(event.clientX, event.clientY, Math.pow(0.999, event.deltaY));
      },
      { passive: false },
    );
  }

  /** Zooms while keeping the document point under the cursor pinned in place. */
  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const zoom = this.engine.getView().zoom * factor;
    if (this.zoomAroundScreenPoint(clientX, clientY, zoom)) {
      this.setHint(`ズーム: ${Math.round(this.engine.getView().zoom * 100)}%`);
    }
  }

  /**
   * Sets the zoom level while keeping whatever document point currently sits at
   * (screenX, screenY) fixed on screen — the shared math behind wheel-zoom (anchored on
   * the cursor) and Ctrl+Space drag-zoom (anchored on the panel center). Returns false
   * when the clamped zoom is unchanged, so callers can skip redundant hint updates.
   */
  private zoomAroundScreenPoint(screenX: number, screenY: number, zoom: number): boolean {
    const view = this.engine.getView();
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (clamped === view.zoom) return false;

    const before = this.engine.screenToDocument(screenX, screenY);
    this.engine.setView({ zoom: clamped });

    const after = this.engine.screenToDocument(screenX, screenY);
    this.engine.setView({
      panX: this.engine.getView().panX + (after.x - before.x) * clamped,
      panY: this.engine.getView().panY + (after.y - before.y) * clamped,
    });
    return true;
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      if (isTypingTarget(event.target) || this.capturingShortcut) return;

      // Enter/Escape belong to the active transform and are not remappable, so they are
      // handled before the shortcut table gets a look at them.
      if (this.transformTool.isActive) {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitTransform();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.cancelTransform();
          return;
        }
      }

      // Fixed alternative for redo, never remappable — it is the combination most people
      // reach for first, and losing it to a rebind would be a surprising way to get stuck.
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyZ') {
        event.preventDefault();
        if (this.history.redo()) this.updateHistoryButtons();
        return;
      }

      const action = this.matchShortcut(event);
      if (!action) return;
      event.preventDefault();

      switch (action) {
        case 'pan':
          this.spaceHeld = true;
          break;
        case 'undo':
          if (this.history.undo()) this.updateHistoryButtons();
          break;
        case 'redo':
          if (this.history.redo()) this.updateHistoryButtons();
          break;
        case 'resetView':
          this.resetView();
          break;
        case 'selectAll':
          this.selection.selectAll();
          this.commitSelection();
          break;
        case 'deselect':
          this.selection.deselect();
          this.commitSelection();
          break;
        case 'invertSelection':
          this.selection.invert();
          this.commitSelection();
          break;
        case 'clearSelection':
          this.clearSelectedArea();
          break;
        default:
          this.setTool(action);
      }
    });

    window.addEventListener('keyup', (event) => {
      if (event.code === this.shortcuts.pan.code) this.spaceHeld = false;
    });

    // Alt+Tab and similar can swallow the keyup that would otherwise clear spaceHeld or
    // end a drag, leaving the tool stuck in pan/zoom mode after focus returns.
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.pan = null;
      this.zoomDrag = null;
      this.canvas.classList.remove('panning');
    });
  }

  private matchShortcut(event: KeyboardEvent): ShortcutAction | null {
    for (const action of SHORTCUT_ACTIONS) {
      if (matchesBinding(this.shortcuts[action], event)) return action;
    }
    return null;
  }

  private resetView(): void {
    this.engine.setView({ panX: 0, panY: 0, zoom: 1 });
    this.setHint('表示をリセットしました');
  }

  private setTool(tool: Tool): void {
    // Leaving the transform tool bakes the edit rather than discarding it — the same thing
    // every editor does, and the alternative is silently losing work on a stray key press.
    if (this.tool === 'transform' && tool !== 'transform') this.commitTransform();

    this.tool = tool;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.classList.toggle('active', button.dataset['tool'] === tool);
    }

    if (tool === 'transform') this.beginTransform();
  }

  // ------------------------------------------------------------------ presets

  private renderPresets(): void {
    const list = requireEl<HTMLUListElement>('presetList');
    list.replaceChildren();

    if (this.presets.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'presetEmpty';
      empty.textContent = '（保存されたブラシはありません）';
      list.append(empty);
      return;
    }

    this.presets.forEach((preset, index) => {
      const row = document.createElement('li');
      row.className = 'presetRow';
      row.classList.toggle('active', index === this.activePresetIndex);
      row.textContent = `${preset.name}　${preset.brush.size}px / ぼかし${preset.brush.blur}`;
      row.addEventListener('click', () => {
        this.activePresetIndex = index;
        this.brush = { ...DEFAULT_BRUSH, ...preset.brush };
        saveBrush(this.brush);
        this.syncControls();
        this.renderPresets();
      });
      list.append(row);
    });
  }

  private addPreset(): void {
    const name = prompt('ブラシ名', `ブラシ ${this.presets.length + 1}`);
    if (!name) return;
    this.presets.push({ name, brush: { ...this.brush } });
    this.activePresetIndex = this.presets.length - 1;
    savePresets(this.presets);
    this.renderPresets();
  }

  private updatePreset(): void {
    const preset = this.presets[this.activePresetIndex];
    if (!preset) return;
    preset.brush = { ...this.brush };
    savePresets(this.presets);
    this.renderPresets();
    this.setHint(`「${preset.name}」を上書きしました`);
  }

  private deletePreset(): void {
    if (this.activePresetIndex < 0) return;
    this.presets.splice(this.activePresetIndex, 1);
    this.activePresetIndex = -1;
    savePresets(this.presets);
    this.renderPresets();
  }

  // ---------------------------------------------------------------- projects

  private saveProject(): void {
    const file = serializeProject(this.doc, this.engine, this.global.bgColor);
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    downloadBlob(blob, `paintsoft-${timestamp()}.psft`);
    this.setHint('プロジェクトを保存しました');
  }

  private async openProject(file: File): Promise<void> {
    this.settleTransformBeforeStructuralChange();
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await loadProject(parsed, this.doc, this.engine);

      this.global.bgColor = result.bgColor;
      saveGlobal(this.global);
      this.engine.setBackgroundColor(hexToRgb(result.bgColor));
      requireEl<HTMLInputElement>('bgColor').value = result.bgColor;

      this.history.clear();
      this.updateHistoryButtons();
      this.resyncSelectionSize();
      this.afterTreeChange();
      this.resetView();

      this.setHint(
        result.disconnectedLayerCount > 0
          ? `読み込みました（出力に未接続だった${result.disconnectedLayerCount}枚は非表示で最下部に配置しました）`
          : `読み込みました（${result.width}×${result.height}）`,
      );
    } catch (error) {
      this.setHint(error instanceof Error ? error.message : 'プロジェクトを読み込めませんでした');
    }
  }

  private async exportPng(): Promise<void> {
    const imageData = this.engine.exportImageData();
    const surface = new OffscreenCanvas(imageData.width, imageData.height);
    surface.getContext('2d')?.putImageData(imageData, 0, 0);
    downloadBlob(await surface.convertToBlob({ type: 'image/png' }), `paintsoft-${timestamp()}.png`);
  }

  // ------------------------------------------------------- desktop .clip bridge

  /** Called by the WPF shell after it has parsed a `.clip` file. */
  async loadClipDocument(dto: ClipDocumentDto): Promise<void> {
    if (!dto?.layers?.length) return;
    this.settleTransformBeforeStructuralChange();

    const width = Math.max(1, Math.floor(dto.width));
    const height = Math.max(1, Math.floor(dto.height));

    this.engine.resetLayers();
    this.doc.reset();
    this.engine.resizeDocument(width, height, { mode: 'crop', anchorX: 0, anchorY: 0 });

    // Delivered bottom-to-top, which is the order sibling lists are stored in.
    for (const layer of dto.layers) {
      const engineLayer = this.engine.createLayer();
      const surface = await decodeLayerOntoCanvas(layer, width, height);
      if (surface) this.engine.uploadLayerImage(engineLayer.id, surface);

      const node = this.doc.createLayer(engineLayer.id, layer.name || 'レイヤー', null);
      node.visible = layer.visible !== false;
    }

    this.history.clear();
    this.updateHistoryButtons();
    this.resyncSelectionSize();
    this.afterTreeChange();
    this.resetView();
    this.setHint(`.clip から ${dto.layers.length} 枚のレイヤーを読み込みました`);
  }

  /** Called by the WPF shell to collect layers for `.clip` writing. Must stay synchronous. */
  getClipExportDocument(): ClipDocumentDto {
    return {
      width: this.engine.width,
      height: this.engine.height,
      layers: this.doc.flattenLayers().map(({ node, visible }) => ({
        name: node.name,
        x: 0,
        y: 0,
        width: this.engine.width,
        height: this.engine.height,
        visible,
        png: imageDataToPngDataUrl(this.engine.exportLayerImageData(node.engineLayerId)),
      })),
    };
  }

  private exportPsd(): void {
    downloadBlob(exportPsd(this.doc, this.engine), `paintsoft-${timestamp()}.psd`);
    this.setHint('PSDを書き出しました（フォルダはグループとして保持されます）');
  }

  // ---------------------------------------------------------------------- UI

  private bindControls(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.addEventListener('click', () => this.setTool(button.dataset['tool'] as Tool));
    }

    this.bindColor('color', () => this.global.color, (value) => {
      this.global.color = value;
    });
    this.bindColor('bgColor', () => this.global.bgColor, (value) => {
      this.global.bgColor = value;
      this.engine.setBackgroundColor(hexToRgb(value));
    });

    this.bindBrushRange('size', 'sizeOut', 'size');
    this.bindBrushRange('sizeMin', 'sizeMinOut', 'sizeMinPercent', '%');
    this.bindBrushRange('sizeMax', 'sizeMaxOut', 'sizeMaxPercent', '%');
    this.bindBrushCheck('sizePressure', 'sizePressureEnabled');

    this.bindBrushRange('opacity', 'opacityOut', 'opacity', '%');
    this.bindBrushRange('opacityMin', 'opacityMinOut', 'opacityMinPercent', '%');
    this.bindBrushRange('opacityMax', 'opacityMaxOut', 'opacityMaxPercent', '%');
    this.bindBrushCheck('opacityPressure', 'opacityPressureEnabled');

    this.bindBrushRange('blur', 'blurOut', 'blur');
    this.bindBrushRange('spacing', 'spacingOut', 'spacingPercent', '%');
    this.bindBrushCheck('buildup', 'buildup');

    const sizeUnit = requireEl<HTMLSelectElement>('sizeUnit');
    sizeUnit.addEventListener('change', () => {
      this.brush.sizeUnit = sizeUnit.value as SizeUnit;
      saveBrush(this.brush);
    });
    this.controlSyncs.push(() => {
      sizeUnit.value = this.brush.sizeUnit;
    });

    this.bindGlobalCheck('pressureEnabled', () => this.global.pressureEnabled, (value) => {
      this.global.pressureEnabled = value;
    });
    this.bindGlobalRange('stabilizer', 'stabilizerOut', () => this.global.stabilizer.positionStrength, (value) => {
      this.global.stabilizer.positionStrength = value;
    });
    this.bindGlobalRange(
      'pressureSmoothing',
      'pressureSmoothingOut',
      () => this.global.stabilizer.pressureStrength,
      (value) => {
        this.global.stabilizer.pressureStrength = value;
      },
    );

    onClick('undo', () => {
      if (this.history.undo()) this.updateHistoryButtons();
    });
    onClick('redo', () => {
      if (this.history.redo()) this.updateHistoryButtons();
    });
    onClick('resetView', () => this.resetView());
    onClick('exportPng', () => void this.exportPng());
    onClick('exportPsd', () => this.exportPsd());
    onClick('benchmark', () => this.runBenchmark());

    onClick('saveProject', () => this.saveProject());
    const openInput = requireEl<HTMLInputElement>('openProjectInput');
    onClick('openProject', () => openInput.click());
    openInput.addEventListener('change', () => {
      const file = openInput.files?.[0];
      if (file) void this.openProject(file);
      openInput.value = '';
    });

    const nodePanel = requireEl('nodePanel');
    const toggleNodePanel = () => {
      nodePanel.hidden = !nodePanel.hidden;
      requireEl('toggleNodePanel').classList.toggle('active', !nodePanel.hidden);
      if (!nodePanel.hidden) this.nodeEditor.render();
    };
    onClick('toggleNodePanel', toggleNodePanel);
    onClick('nodePanelClose', toggleNodePanel);

    onClick('selectAll', () => {
      this.selection.selectAll();
      this.commitSelection();
      this.setHint('すべて選択しました');
    });
    onClick('deselect', () => {
      this.selection.deselect();
      this.commitSelection();
      this.setHint('選択を解除しました');
    });
    onClick('invertSelection', () => {
      this.selection.invert();
      this.commitSelection();
      this.setHint('選択範囲を反転しました');
    });
    onClick('clearSelection', () => this.clearSelectedArea());
    onClick('fillSelection', () => this.fillSelectedArea());
    this.updateSelectionButtons();

    onClick('layerAdd', () => this.addLayer());
    onClick('folderAdd', () => this.addFolder());
    onClick('layerClear', () => this.clearActiveLayer());
    onClick('layerDelete', () => this.deleteActiveNode());

    onClick('presetAdd', () => this.addPreset());
    onClick('presetUpdate', () => this.updatePreset());
    onClick('presetDelete', () => this.deletePreset());

    this.bindLayerProperties();
    this.updateHistoryButtons();
  }

  /** Blend mode and opacity for whichever node is selected, folders included. */
  private bindLayerProperties(): void {
    const blend = requireEl<HTMLSelectElement>('layerBlend');
    const opacity = requireEl<HTMLInputElement>('layerOpacity');
    const opacityOut = requireEl<HTMLOutputElement>('layerOpacityOut');

    for (const mode of BLEND_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = BLEND_MODE_LABELS[mode];
      blend.append(option);
    }

    blend.addEventListener('change', () => {
      const node = this.selectedNode();
      if (!node || !isBlendMode(blend.value)) return;
      node.blend = blend.value;
      this.syncRenderTree();
      this.renderLayers();
    });

    opacity.addEventListener('input', () => {
      const node = this.selectedNode();
      if (!node) return;
      node.opacity = Number(opacity.value) / 100;
      opacityOut.textContent = `${opacity.value}%`;
      this.syncRenderTree();
    });

    // Committing on release keeps the list from re-rendering on every slider step.
    opacity.addEventListener('change', () => this.renderLayers());

    const clipped = requireEl<HTMLInputElement>('layerClipped');
    clipped.addEventListener('change', () => {
      const node = this.selectedNode();
      if (!node) return;
      node.clipped = clipped.checked;
      this.afterTreeChange();
    });

    onClick('maskAdd', () => {
      const layerId = this.doc.activeLayer?.engineLayerId;
      if (layerId === undefined || this.engine.hasMask(layerId)) return;
      this.engine.createLayerMask(layerId, 'reveal');
      this.maskEditing = true;
      this.renderLayers();
      this.setHint('マスクを追加しました。黒で塗ると隠れます');
    });

    onClick('maskDelete', () => {
      const layerId = this.doc.activeLayer?.engineLayerId;
      if (layerId === undefined || !this.engine.hasMask(layerId)) return;
      this.engine.deleteLayerMask(layerId);
      this.maskEditing = false;
      // A mask edit's undo snapshots point at a buffer that no longer exists.
      this.history.clear();
      this.updateHistoryButtons();
      this.renderLayers();
      this.setHint('マスクを削除しました');
    });

    const maskEdit = requireEl<HTMLInputElement>('maskEdit');
    maskEdit.addEventListener('change', () => {
      this.maskEditing = maskEdit.checked;
      this.setHint(this.maskEditing ? 'マスクを編集中です' : 'レイヤーを編集中です');
    });
  }

  private selectedNode() {
    return this.doc.selectedId === null ? null : (this.doc.nodes.get(this.doc.selectedId) ?? null);
  }

  private syncLayerProperties(): void {
    const node = this.selectedNode();
    const blend = requireEl<HTMLSelectElement>('layerBlend');
    const opacity = requireEl<HTMLInputElement>('layerOpacity');
    const opacityOut = requireEl<HTMLOutputElement>('layerOpacityOut');

    const clipped = requireEl<HTMLInputElement>('layerClipped');
    const maskEdit = requireEl<HTMLInputElement>('maskEdit');

    blend.disabled = !node;
    opacity.disabled = !node;
    clipped.disabled = !node;

    // Mask controls follow the drawing target, not the selection: a folder can be selected
    // while strokes still land on a layer, and that layer's mask is the relevant one.
    const layerId = this.doc.activeLayer?.engineLayerId;
    const hasMask = layerId !== undefined && this.engine.hasMask(layerId);
    requireEl<HTMLButtonElement>('maskAdd').disabled = layerId === undefined || hasMask;
    requireEl<HTMLButtonElement>('maskDelete').disabled = !hasMask;
    maskEdit.disabled = !hasMask;
    if (!hasMask) this.maskEditing = false;
    maskEdit.checked = this.maskEditing;

    if (!node) return;

    blend.value = node.blend;
    opacity.value = String(Math.round(node.opacity * 100));
    opacityOut.textContent = `${opacity.value}%`;
    clipped.checked = node.clipped;
  }

  private bindBrushRange(
    inputId: string,
    outputId: string,
    key: NumericBrushKey,
    suffix = '',
  ): void {
    const input = requireEl<HTMLInputElement>(inputId);
    const output = requireEl<HTMLOutputElement>(outputId);

    input.addEventListener('input', () => {
      this.brush[key] = Number(input.value);
      output.textContent = `${input.value}${suffix}`;
      saveBrush(this.brush);
    });

    this.controlSyncs.push(() => {
      input.value = String(this.brush[key]);
      output.textContent = `${this.brush[key]}${suffix}`;
    });
  }

  private bindBrushCheck(inputId: string, key: BooleanBrushKey): void {
    const input = requireEl<HTMLInputElement>(inputId);
    input.addEventListener('change', () => {
      this.brush[key] = input.checked;
      saveBrush(this.brush);
    });
    this.controlSyncs.push(() => {
      input.checked = this.brush[key];
    });
  }

  private bindGlobalRange(
    inputId: string,
    outputId: string,
    get: () => number,
    set: (value: number) => void,
  ): void {
    const input = requireEl<HTMLInputElement>(inputId);
    const output = requireEl<HTMLOutputElement>(outputId);

    input.addEventListener('input', () => {
      set(Number(input.value));
      output.textContent = input.value;
      saveGlobal(this.global);
    });
    this.controlSyncs.push(() => {
      input.value = String(get());
      output.textContent = String(get());
    });
  }

  private bindGlobalCheck(inputId: string, get: () => boolean, set: (value: boolean) => void): void {
    const input = requireEl<HTMLInputElement>(inputId);
    input.addEventListener('change', () => {
      set(input.checked);
      saveGlobal(this.global);
    });
    this.controlSyncs.push(() => {
      input.checked = get();
    });
  }

  private bindColor(inputId: string, get: () => string, set: (value: string) => void): void {
    const input = requireEl<HTMLInputElement>(inputId);
    input.addEventListener('input', () => {
      set(input.value);
      saveGlobal(this.global);
    });
    this.controlSyncs.push(() => {
      input.value = get();
    });
  }

  private syncControls(): void {
    for (const sync of this.controlSyncs) sync();
  }

  private bindCanvasDialog(): void {
    const dialog = requireEl<HTMLDialogElement>('canvasDialog');
    const widthInput = requireEl<HTMLInputElement>('canvasWidth');
    const heightInput = requireEl<HTMLInputElement>('canvasHeight');
    const lockAspect = requireEl<HTMLInputElement>('lockAspect');
    const anchorWrap = requireEl('anchorWrap');
    const modeHint = requireEl('modeHint');
    const modeScale = requireEl<HTMLButtonElement>('modeScale');
    const modeCrop = requireEl<HTMLButtonElement>('modeCrop');

    const setMode = (mode: 'scale' | 'crop') => {
      this.canvasMode = mode;
      modeScale.setAttribute('aria-pressed', String(mode === 'scale'));
      modeCrop.setAttribute('aria-pressed', String(mode === 'crop'));
      anchorWrap.hidden = mode !== 'crop';
      modeHint.textContent =
        mode === 'scale'
          ? '絵の内容を新しいサイズに合わせて拡大縮小します。'
          : '絵の大きさはそのままに、キャンバスの範囲だけを切り抜き・拡張します。';
    };

    modeScale.addEventListener('click', () => setMode('scale'));
    modeCrop.addEventListener('click', () => setMode('crop'));

    for (const cell of requireEl('anchorGrid').querySelectorAll<HTMLButtonElement>('button')) {
      cell.addEventListener('click', () => {
        for (const other of requireEl('anchorGrid').querySelectorAll('button')) other.classList.remove('active');
        cell.classList.add('active');
        this.canvasAnchor = { x: Number(cell.dataset['x']), y: Number(cell.dataset['y']) };
      });
    }

    // Aspect ratio is locked against the size the dialog opened with, so repeated tweaks
    // to one field don't compound rounding drift into the other.
    let ratio = 1;
    widthInput.addEventListener('input', () => {
      if (lockAspect.checked) heightInput.value = String(Math.max(1, Math.round(Number(widthInput.value) / ratio)));
    });
    heightInput.addEventListener('input', () => {
      if (lockAspect.checked) widthInput.value = String(Math.max(1, Math.round(Number(heightInput.value) * ratio)));
    });

    onClick('canvasSettings', () => {
      widthInput.value = String(this.engine.width);
      heightInput.value = String(this.engine.height);
      ratio = this.engine.width / this.engine.height;
      setMode(this.canvasMode);
      dialog.showModal();
    });

    // Committed from the button's own click rather than the dialog's `close` event: `close`
    // is queued as a separate task, so tying the commit to it makes the whole operation
    // depend on an event that is easy to miss and awkward to drive from a test.
    onClick('canvasApply', () => {
      const width = Math.max(1, Math.min(8192, Math.floor(Number(widthInput.value))));
      const height = Math.max(1, Math.min(8192, Math.floor(Number(heightInput.value))));
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;

      this.settleTransformBeforeStructuralChange();
      this.engine.resizeDocument(width, height, {
        mode: this.canvasMode,
        anchorX: this.canvasAnchor.x,
        anchorY: this.canvasAnchor.y,
      });
      // Snapshots in the undo stack are sized against the previous canvas, so restoring
      // one after a resize would paste a mismatched region back into the layer.
      this.history.clear();
      this.updateHistoryButtons();
      this.resyncSelectionSize();
      this.resetView();
      this.setHint(`キャンバスを ${width}×${height} に変更しました`);
    });
  }

  /**
   * Edits are staged in a draft and only committed on 保存, matching v1: the dialog reads
   * raw key presses, so a mistaken capture that took effect immediately could rebind the
   * very keys needed to recover.
   */
  private bindShortcutDialog(): void {
    const dialog = requireEl<HTMLDialogElement>('shortcutDialog');
    const rows = requireEl('shortcutRows');
    let draft = { ...this.shortcuts };
    let capturing: ShortcutAction | null = null;

    const render = () => {
      rows.replaceChildren();
      for (const action of SHORTCUT_ACTIONS) {
        const row = document.createElement('div');
        row.className = 'shortcutRow';
        row.classList.toggle('capturing', capturing === action);

        const label = document.createElement('span');
        label.textContent = SHORTCUT_LABELS[action];

        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'shortcutKey';
        key.textContent = capturing === action ? 'キーを押してください…' : describeBinding(draft[action]);
        key.addEventListener('click', () => {
          capturing = capturing === action ? null : action;
          this.capturingShortcut = capturing !== null;
          render();
        });

        row.append(label, key);

        const conflicts = findConflicts(draft, action);
        if (conflicts.length > 0) {
          const warning = document.createElement('span');
          warning.className = 'shortcutConflict';
          warning.textContent = `重複: ${conflicts.map((other) => SHORTCUT_LABELS[other]).join('、')}`;
          row.append(warning);
        }

        rows.append(row);
      }
    };

    // Capture happens on the dialog rather than the window so it cannot fire while the
    // dialog is closed, and it runs before the app's own handler either way.
    dialog.addEventListener('keydown', (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        capturing = null;
        this.capturingShortcut = false;
        render();
        return;
      }
      if (isModifierOnly(event.code)) return;

      draft[capturing] = bindingFromEvent(event);
      capturing = null;
      this.capturingShortcut = false;
      render();
    });

    requireEl('shortcutReset').addEventListener('click', () => {
      draft = { ...DEFAULT_SHORTCUTS };
      render();
    });

    onClick('shortcutSettings', () => {
      draft = { ...this.shortcuts };
      capturing = null;
      this.capturingShortcut = false;
      render();
      dialog.showModal();
    });

    onClick('shortcutApply', () => {
      this.shortcuts = draft;
      saveShortcuts(this.shortcuts);
      capturing = null;
      this.capturingShortcut = false;
      this.setHint('ショートカットを保存しました');
    });

    // Escape closes without submitting, so the capture flag has to be released here too or
    // every shortcut would stay dead until the dialog was opened again.
    dialog.addEventListener('cancel', () => {
      capturing = null;
      this.capturingShortcut = false;
    });
    requireEl('shortcutCancel').addEventListener('click', () => {
      capturing = null;
      this.capturingShortcut = false;
    });
  }

  private updateHistoryButtons(): void {
    requireEl<HTMLButtonElement>('undo').disabled = !this.history.canUndo;
    requireEl<HTMLButtonElement>('redo').disabled = !this.history.canRedo;
  }

  private setHint(text: string): void {
    requireEl('hint').textContent = text;
  }

  private startStatsLoop(): void {
    const statsEl = requireEl('stats');
    const update = () => {
      const stats = this.engine.getStats();
      statsEl.textContent = [
        `frame    ${stats.frameMs.toFixed(2)} ms`,
        `layers   ${stats.compositedLayers}`,
        `stroke   ${stats.strokeStamps} stamps`,
        `canvas   ${this.engine.width}×${this.engine.height}`,
        `zoom     ${Math.round(this.engine.getView().zoom * 100)}%`,
      ].join('\n');
    };
    update();
    window.setInterval(update, 120);
  }

  // --------------------------------------------------------------- benchmark

  /**
   * Submits a deliberately punishing stroke — a large, soft, closely-spaced brush, the
   * exact combination that made the v1 CPU path fall over — and reports how long the GPU
   * actually took. `finish()` brackets the measurement so the number reflects completed
   * rasterisation rather than just how fast the commands were queued.
   */
  private runBenchmark(): void {
    const layerId = this.activeEngineLayerId();
    if (layerId === null) return;

    const { gl } = this.engine;
    const radius = 150;
    const stampCount = 2000;

    const buffer = new StampBuffer(stampCount);
    for (let i = 0; i < stampCount; i += 1) {
      const t = i / stampCount;
      buffer.push(
        this.engine.width * (0.5 + 0.42 * Math.cos(t * Math.PI * 12)),
        this.engine.height * (0.5 + 0.42 * Math.sin(t * Math.PI * 9)),
        radius,
        0.5,
      );
    }

    this.engine.beginStroke(layerId, {
      color: hexToRgb(this.global.color),
      blur: 60,
      buildup: false,
      erase: false,
    });

    gl.finish();
    const started = performance.now();
    this.engine.addStamps(buffer);
    gl.finish();
    const elapsed = performance.now() - started;

    this.engine.endStroke();
    this.updateHistoryButtons();

    const gigapixels = (stampCount * Math.PI * (radius * 1.96) ** 2) / 1e9;
    this.setHint(
      `負荷テスト: ${stampCount}スタンプ (半径${radius}px・ぼかし60) を ${elapsed.toFixed(1)}ms ` +
        `= 約${(gigapixels / (elapsed / 1000)).toFixed(1)} Gpx/s`,
    );
  }
}

// ------------------------------------------------------------------ helpers

type NumericBrushKey = {
  [K in keyof BrushSettings]: BrushSettings[K] extends number ? K : never;
}[keyof BrushSettings];

type BooleanBrushKey = {
  [K in keyof BrushSettings]: BrushSettings[K] extends boolean ? K : never;
}[keyof BrushSettings];

function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function onClick(id: string, handler: () => void): void {
  requireEl(id).addEventListener('click', handler);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** '#rrggbb' (or '#rgb') to three 0..1 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace('#', '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((channel) => channel + channel)
      .join('');
  }

  const int = Number.parseInt(value, 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}
