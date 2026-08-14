import type { DocNode, FolderNode, NodeId, PaintDocument } from '../core/Document';
import { BLEND_MODE_LABELS } from '../engine/blendModes';

export interface NodeEditorCallbacks {
  onSelect(id: NodeId): void;
  onChanged(): void;
}

const BOX_WIDTH = 210;
const OUTPUT_ANCHOR = { x: 12, y: 28 };

/**
 * v1's node view, rebuilt over the v2 layer tree.
 *
 * The one idea carried over intact is that **geometry is the stack order**: a top-level
 * node's Y position decides where it sits in the stack (lower on screen = lower down), and
 * dropping a box re-derives the order from the new positions. That is the same rule v1's
 * `.psft` encodes, which is why node layouts survive a round trip between the two versions.
 *
 * The wire to the 出力 node stands for visibility — v1 excluded unrouted nodes from the
 * composite, and v2's `visible` flag means exactly that. Nodes inside a folder are drawn as
 * rows in their parent's box rather than as free boxes, again matching v1.
 */
export class NodeEditor {
  private dragging: { id: NodeId; pointerId: number; offsetX: number; offsetY: number } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: PaintDocument,
    private readonly callbacks: NodeEditorCallbacks,
  ) {}

  render(): void {
    this.root.replaceChildren();

    const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wires.setAttribute('class', 'nodeWires');
    this.root.append(wires);

    const output = document.createElement('div');
    output.className = 'nodeOutput';
    output.textContent = '出力';
    output.style.left = '10px';
    output.style.top = '10px';
    this.root.append(output);

    let maxBottom = 0;
    for (const id of this.doc.rootIds) {
      const node = this.doc.nodes.get(id);
      if (!node) continue;

      const box = this.renderBox(node);
      this.root.append(box);
      maxBottom = Math.max(maxBottom, node.editorY + box.offsetHeight);

      if (node.visible) this.drawWire(wires, node, box.offsetHeight);
    }

    // The panel scrolls, so the SVG has to span the full content height or wires to the
    // lower boxes would be clipped at the visible edge.
    this.root.style.minHeight = `${maxBottom + 120}px`;
    wires.setAttribute('width', '100%');
    wires.setAttribute('height', `${maxBottom + 120}`);
  }

  private renderBox(node: DocNode): HTMLElement {
    const box = document.createElement('div');
    box.className = 'nodeBox';
    box.classList.toggle('selected', node.id === this.doc.selectedId);
    box.classList.toggle('hidden', !node.visible);
    box.classList.toggle('folder', node.kind === 'folder');
    box.style.left = `${node.editorX + 110}px`;
    box.style.top = `${node.editorY + 10}px`;
    box.style.width = `${BOX_WIDTH}px`;

    const head = document.createElement('div');
    head.className = 'nodeHead';

    const port = document.createElement('button');
    port.type = 'button';
    port.className = 'nodePort';
    port.title = node.visible ? '出力への接続を切る（非表示）' : '出力へ接続する（表示）';
    port.addEventListener('click', (event) => {
      event.stopPropagation();
      node.visible = !node.visible;
      this.callbacks.onChanged();
    });

    const title = document.createElement('span');
    title.className = 'nodeTitle';
    title.textContent = `${node.kind === 'folder' ? '📁 ' : ''}${node.name}`;

    head.append(port, title);

    const meta = document.createElement('div');
    meta.className = 'nodeMeta';
    meta.textContent = `${BLEND_MODE_LABELS[node.blend]} · ${Math.round(node.opacity * 100)}%`;

    box.append(head, meta);

    if (node.kind === 'folder') {
      box.append(this.renderFolderChildren(node));
    }

    box.addEventListener('pointerdown', (event) => this.beginDrag(event, node, box));
    box.addEventListener('click', () => this.callbacks.onSelect(node.id));

    return box;
  }

  private renderFolderChildren(folder: FolderNode): HTMLElement {
    const list = document.createElement('div');
    list.className = 'nodeChildren';

    // Listed top-first, like the layer panel, while childIds stays bottom-first.
    for (let i = folder.childIds.length - 1; i >= 0; i -= 1) {
      const child = this.doc.nodes.get(folder.childIds[i]!);
      if (!child) continue;

      const row = document.createElement('div');
      row.className = 'nodeChildRow';
      row.classList.toggle('selected', child.id === this.doc.selectedId);
      row.classList.toggle('hidden', !child.visible);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nodeChildToggle';
      toggle.textContent = child.visible ? '👁' : '🚫';
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        child.visible = !child.visible;
        this.callbacks.onChanged();
      });

      const name = document.createElement('span');
      name.textContent = `${child.kind === 'folder' ? '📁 ' : ''}${child.name}`;

      row.append(toggle, name);
      row.addEventListener('pointerdown', (event) => event.stopPropagation());
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onSelect(child.id);
      });
      list.append(row);
    }

    if (folder.childIds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'nodeChildEmpty';
      empty.textContent = '（空のフォルダ）';
      list.append(empty);
    }

    return list;
  }

  private beginDrag(event: PointerEvent, node: DocNode, box: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();

    box.setPointerCapture(event.pointerId);
    this.dragging = {
      id: node.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - box.offsetLeft,
      offsetY: event.clientY - box.offsetTop,
    };
    box.classList.add('dragging');

    const move = (moveEvent: PointerEvent) => {
      if (this.dragging?.pointerId !== moveEvent.pointerId) return;
      node.editorX = Math.max(0, moveEvent.clientX - this.dragging.offsetX - 110);
      node.editorY = Math.max(0, moveEvent.clientY - this.dragging.offsetY - 10);
      box.style.left = `${node.editorX + 110}px`;
      box.style.top = `${node.editorY + 10}px`;
    };

    const end = (endEvent: PointerEvent) => {
      if (this.dragging?.pointerId !== endEvent.pointerId) return;
      this.dragging = null;
      box.classList.remove('dragging');
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);

      // Position is the ordering, so committing the drag means re-deriving the stack.
      this.doc.reorderFromEditorPositions();
      this.callbacks.onChanged();
    };

    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  private drawWire(svg: SVGSVGElement, node: DocNode, boxHeight: number): void {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const startX = node.editorX + 110;
    const startY = node.editorY + 10 + Math.min(20, boxHeight / 2);
    const endX = OUTPUT_ANCHOR.x + 62;
    const endY = OUTPUT_ANCHOR.y;
    const midX = (startX + endX) / 2;

    path.setAttribute('d', `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`);
    path.setAttribute('class', 'nodeWire');
    svg.append(path);
  }
}
