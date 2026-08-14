import type { Engine, StrokeTarget } from '../engine/Engine';
import type { Rect } from '../engine/gl/Compositor';
import type { RenderTarget } from '../engine/gl/RenderTarget';

interface HistoryEntry {
  layerId: number;
  rect: Rect;
  /** Which of the layer's buffers the snapshots belong to. */
  target: StrokeTarget;
  before: RenderTarget;
  after: RenderTarget;
}

/**
 * Undo/redo over *regions* of a layer rather than whole-canvas snapshots.
 *
 * v1 pushed a full serialised copy of every layer onto the undo stack per operation, so
 * one dab on a large canvas cost as much memory and time as repainting the whole thing.
 * Because the engine reports the exact rect a stroke touched, each entry here only needs
 * the pixels inside that rect, held as a GPU texture — a stroke in one corner of a 4000px
 * canvas costs a few hundred KB of VRAM and no CPU readback at all.
 */
export class History {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly limit = 40,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  record(
    layerId: number,
    rect: Rect,
    before: RenderTarget,
    after: RenderTarget,
    target: StrokeTarget = 'color',
  ): void {
    this.undoStack.push({ layerId, rect, target, before, after });

    // A new edit invalidates the redo branch, so those textures are unreachable now.
    for (const entry of this.redoStack) disposeEntry(entry);
    this.redoStack.length = 0;

    while (this.undoStack.length > this.limit) {
      const evicted = this.undoStack.shift();
      if (evicted) disposeEntry(evicted);
    }
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.engine.restoreRegion(entry.layerId, entry.before, entry.rect, entry.target);
    this.redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.engine.restoreRegion(entry.layerId, entry.after, entry.rect, entry.target);
    this.undoStack.push(entry);
    return true;
  }

  clear(): void {
    for (const entry of this.undoStack) disposeEntry(entry);
    for (const entry of this.redoStack) disposeEntry(entry);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

function disposeEntry(entry: HistoryEntry): void {
  entry.before.dispose();
  entry.after.dispose();
}
