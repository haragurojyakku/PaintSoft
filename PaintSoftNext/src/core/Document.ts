import type { LayerBlendMode } from '../engine/blendModes';
import type { RenderNode } from '../engine/Engine';

export type NodeId = number;

interface NodeBase {
  id: NodeId;
  name: string;
  visible: boolean;
  opacity: number;
  blend: LayerBlendMode;
  /**
   * When true, this node is clipped to the nearest unclipped sibling below it: it only
   * shows where that node has alpha. A run of consecutive clipped nodes shares one base,
   * which is the "clipping group" every illustration tool works this way.
   */
  clipped: boolean;
  /** Containing folder, or null when the node sits at the top level. */
  parentId: NodeId | null;
  /**
   * Position in the node editor. Meaningful for top-level nodes only — nodes inside a
   * folder are drawn as rows within their parent's box, exactly as in v1.
   *
   * Y is not merely cosmetic: it *is* the stack order for top-level nodes (lower on screen
   * = lower in the stack), which is also how v1's `.psft` encodes ordering, so positions
   * survive a round trip through either version.
   */
  editorX: number;
  editorY: number;
}

/** Vertical spacing used when positions are regenerated from the tree order. */
export const EDITOR_ROW_HEIGHT = 74;
export const EDITOR_COLUMN_X = 40;

export interface LayerNode extends NodeBase {
  kind: 'layer';
  /** Handle for the pixel buffer this node draws, owned by the Engine. */
  engineLayerId: number;
}

export interface FolderNode extends NodeBase {
  kind: 'folder';
  collapsed: boolean;
  /** Bottom-to-top, matching `rootIds`. */
  childIds: NodeId[];
}

export type DocNode = LayerNode | FolderNode;

export interface FlatEntry {
  node: DocNode;
  depth: number;
  /** The node's own flag combined with every ancestor folder's. */
  effectiveVisible: boolean;
}

/**
 * The layer tree: what exists, how it nests, and in what order it stacks.
 *
 * Sibling lists (`rootIds` and each folder's `childIds`) run **bottom-to-top**, matching
 * both the order the compositor draws in and v1's `.psft` child ordering. Only the layer
 * list UI reverses them, so nothing in the model or the file format has to think about it.
 */
export class PaintDocument {
  readonly nodes = new Map<NodeId, DocNode>();
  rootIds: NodeId[] = [];

  /**
   * What the layer panel highlights — any node, including a folder.
   *
   * Kept separate from `activeLayerId` because a folder can be selected (to rename it, add
   * into it, or change its opacity) while there is still a definite layer that strokes land
   * on. Collapsing the two would mean selecting a folder silently disabled drawing.
   */
  selectedId: NodeId | null = null;

  /** Where strokes go. Only ever a layer id. */
  activeLayerId: NodeId | null = null;

  private nextId = 1;

  // ------------------------------------------------------------------ create

  createLayer(engineLayerId: number, name?: string, parentId: NodeId | null = null): LayerNode {
    const node: LayerNode = {
      kind: 'layer',
      id: this.nextId++,
      name: name ?? `レイヤー ${this.nextId - 1}`,
      visible: true,
      opacity: 1,
      blend: 'normal',
      clipped: false,
      parentId,
      editorX: EDITOR_COLUMN_X,
      editorY: 0,
      engineLayerId,
    };
    this.attach(node);
    this.activeLayerId = node.id;
    this.selectedId = node.id;
    return node;
  }

  createFolder(name?: string, parentId: NodeId | null = null): FolderNode {
    const node: FolderNode = {
      kind: 'folder',
      id: this.nextId++,
      name: name ?? `フォルダ ${this.nextId - 1}`,
      visible: true,
      opacity: 1,
      blend: 'normal',
      clipped: false,
      parentId,
      editorX: EDITOR_COLUMN_X,
      editorY: 0,
      collapsed: false,
      childIds: [],
    };
    this.attach(node);
    this.selectedId = node.id;
    return node;
  }

  /** Selects any node, moving the drawing target too when it is a layer. */
  select(id: NodeId): void {
    if (!this.nodes.has(id)) return;
    this.selectedId = id;
    if (this.nodes.get(id)?.kind === 'layer') this.activeLayerId = id;
  }

  private attach(node: DocNode): void {
    this.nodes.set(node.id, node);
    this.siblingList(node.parentId).push(node.id);
    if (node.parentId === null) this.relayoutEditorPositions();
  }

  /**
   * Rewrites top-level editor positions from the current stack order, so the node view
   * matches after a change made anywhere else (layer panel drag, add, delete, load).
   *
   * rootIds runs bottom-first and screen Y grows downwards, so the first entry gets the
   * largest Y.
   */
  relayoutEditorPositions(): void {
    const count = this.rootIds.length;
    this.rootIds.forEach((id, index) => {
      const node = this.nodes.get(id);
      if (!node) return;
      node.editorX = EDITOR_COLUMN_X;
      node.editorY = (count - 1 - index) * EDITOR_ROW_HEIGHT;
    });
  }

  /**
   * The inverse: re-derives the stack order from where the boxes now sit, after a drag in
   * the node editor. Ties fall back to the existing order so a nudge never shuffles
   * unrelated nodes.
   */
  reorderFromEditorPositions(): void {
    const previous = new Map(this.rootIds.map((id, index) => [id, index]));
    this.rootIds.sort((a, b) => {
      const nodeA = this.nodes.get(a);
      const nodeB = this.nodes.get(b);
      if (!nodeA || !nodeB) return 0;
      if (nodeA.editorY !== nodeB.editorY) return nodeB.editorY - nodeA.editorY;
      return (previous.get(a) ?? 0) - (previous.get(b) ?? 0);
    });
  }

  /** Live reference to whichever sibling array a node with this parent belongs in. */
  private siblingList(parentId: NodeId | null): NodeId[] {
    if (parentId === null) return this.rootIds;
    const parent = this.nodes.get(parentId);
    if (parent?.kind !== 'folder') return this.rootIds;
    return parent.childIds;
  }

  // ------------------------------------------------------------------ mutate

  /** Removes a node and everything under it. Returns the engine layer ids to free. */
  remove(id: NodeId): number[] {
    const node = this.nodes.get(id);
    if (!node) return [];

    const siblings = this.siblingList(node.parentId);
    const index = siblings.indexOf(id);
    if (index >= 0) siblings.splice(index, 1);

    const freed: number[] = [];
    const collect = (current: DocNode) => {
      if (current.kind === 'layer') {
        freed.push(current.engineLayerId);
      } else {
        for (const childId of [...current.childIds]) {
          const child = this.nodes.get(childId);
          if (child) collect(child);
        }
      }
      this.nodes.delete(current.id);
    };
    collect(node);

    if (this.activeLayerId === null || !this.nodes.has(this.activeLayerId)) {
      this.activeLayerId = this.firstLayer()?.id ?? null;
    }
    if (this.selectedId === null || !this.nodes.has(this.selectedId)) {
      this.selectedId = this.activeLayerId;
    }
    return freed;
  }

  /**
   * Reparents/reorders a node. `index` is a position in the destination sibling list
   * *after* the node has been taken out of its current one.
   */
  move(id: NodeId, parentId: NodeId | null, index: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    // Dropping a folder inside itself would detach that whole subtree from the tree.
    if (parentId !== null && (parentId === id || this.isDescendant(parentId, id))) return false;

    const from = this.siblingList(node.parentId);
    const at = from.indexOf(id);
    if (at >= 0) from.splice(at, 1);

    node.parentId = parentId;
    const to = this.siblingList(parentId);
    to.splice(Math.max(0, Math.min(to.length, index)), 0, id);
    this.relayoutEditorPositions();
    return true;
  }

  private isDescendant(candidateId: NodeId, ancestorId: NodeId): boolean {
    let current = this.nodes.get(candidateId);
    while (current?.parentId != null) {
      if (current.parentId === ancestorId) return true;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }

  // ------------------------------------------------------------------ query

  getLayer(id: NodeId): LayerNode | null {
    const node = this.nodes.get(id);
    return node?.kind === 'layer' ? node : null;
  }

  get activeLayer(): LayerNode | null {
    return this.activeLayerId === null ? null : this.getLayer(this.activeLayerId);
  }

  firstLayer(): LayerNode | null {
    for (const entry of this.flatten()) {
      if (entry.node.kind === 'layer') return entry.node;
    }
    return null;
  }

  get layerCount(): number {
    let count = 0;
    for (const node of this.nodes.values()) if (node.kind === 'layer') count += 1;
    return count;
  }

  /** Depth-first walk, bottom-to-top, with cascaded visibility. */
  flatten(includeCollapsed = true): FlatEntry[] {
    const out: FlatEntry[] = [];

    const walk = (ids: readonly NodeId[], depth: number, ancestorsVisible: boolean) => {
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (!node) continue;

        const effectiveVisible = ancestorsVisible && node.visible;
        out.push({ node, depth, effectiveVisible });

        if (node.kind === 'folder' && (includeCollapsed || !node.collapsed)) {
          walk(node.childIds, depth + 1, effectiveVisible);
        }
      }
    };

    walk(this.rootIds, 0, true);
    return out;
  }

  /** Every layer in composite order, tagged with cascaded visibility — for PSD/.clip export. */
  flattenLayers(): { node: LayerNode; visible: boolean }[] {
    return this.flatten()
      .filter((entry): entry is FlatEntry & { node: LayerNode } => entry.node.kind === 'layer')
      .map((entry) => ({ node: entry.node, visible: entry.effectiveVisible }));
  }

  /** What the engine composites. Hidden subtrees are dropped rather than drawn at zero alpha. */
  buildRenderTree(): RenderNode[] {
    const toRenderNode = (node: DocNode): RenderNode | null => {
      if (node.kind === 'layer') {
        return { kind: 'layer', layerId: node.engineLayerId, opacity: node.opacity, blend: node.blend };
      }
      const children = build(node.childIds);
      if (children.length === 0) return null;
      return { kind: 'group', opacity: node.opacity, blend: node.blend, children };
    };

    const build = (ids: readonly NodeId[]): RenderNode[] => {
      const out: RenderNode[] = [];

      for (let i = 0; i < ids.length; i += 1) {
        const node = this.nodes.get(ids[i]!);
        if (!node || !node.visible || node.opacity <= 0) continue;

        const rendered = toRenderNode(node);
        if (!rendered) continue;

        // A clipped node with nothing to clip to (nothing below it, or the node below is
        // hidden) falls back to drawing normally — matching how these tools behave rather
        // than making the layer vanish.
        if (node.clipped) {
          out.push(rendered);
          continue;
        }

        // Gather the run of clipped siblings sitting directly on top of this one.
        const members: RenderNode[] = [];
        while (i + 1 < ids.length) {
          const next = this.nodes.get(ids[i + 1]!);
          if (!next?.clipped) break;
          i += 1;
          if (!next.visible || next.opacity <= 0) continue;
          const renderedMember = toRenderNode(next);
          if (renderedMember) members.push(renderedMember);
        }

        out.push(members.length > 0 ? { kind: 'clip', base: rendered, members } : rendered);
      }

      return out;
    };

    return build(this.rootIds);
  }

  reset(): void {
    this.nodes.clear();
    this.rootIds = [];
    this.activeLayerId = null;
    this.selectedId = null;
    this.nextId = 1;
  }
}
