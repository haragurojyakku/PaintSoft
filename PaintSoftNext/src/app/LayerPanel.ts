import type { DocNode, NodeId, PaintDocument } from '../core/Document';
import { BLEND_MODE_LABELS, type LayerBlendMode } from '../engine/blendModes';

export interface LayerPanelCallbacks {
  onSelect(id: NodeId): void;
  onChanged(): void;
}

/**
 * The layer tree UI.
 *
 * Renders top-first (the order every illustration tool lists layers in) while the document
 * stores siblings bottom-first, so each sibling group is reversed exactly once here and
 * nowhere else. Drag-and-drop reordering maps a drop position back through that same
 * reversal to an index in the document's ordering.
 */
export class LayerPanel {
  private dragId: NodeId | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: PaintDocument,
    private readonly callbacks: LayerPanelCallbacks,
  ) {}

  render(): void {
    this.root.replaceChildren();
    this.renderSiblings(this.doc.rootIds, 0);
  }

  private renderSiblings(ids: readonly NodeId[], depth: number): void {
    // Reversed so the topmost layer in the stack appears at the top of the list.
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const node = this.doc.nodes.get(ids[i]!);
      if (!node) continue;

      this.root.append(this.renderRow(node, depth));

      if (node.kind === 'folder' && !node.collapsed) {
        this.renderSiblings(node.childIds, depth + 1);
      }
    }
  }

  private renderRow(node: DocNode, depth: number): HTMLElement {
    const row = document.createElement('li');
    row.className = 'layerRow';
    row.classList.toggle('active', node.id === this.doc.selectedId);
    // Marked separately from the selection: with a folder selected, this is the row that
    // still shows where a stroke would actually land.
    row.classList.toggle('drawTarget', node.id === this.doc.activeLayerId);
    row.classList.toggle('hidden', !node.visible);
    row.classList.toggle('folder', node.kind === 'folder');
    row.style.paddingLeft = `${9 + depth * 14}px`;
    row.draggable = true;
    row.dataset['id'] = String(node.id);

    if (node.kind === 'folder') {
      const twisty = document.createElement('button');
      twisty.type = 'button';
      twisty.className = 'twisty';
      twisty.textContent = node.collapsed ? '▶' : '▼';
      twisty.title = node.collapsed ? '開く' : '閉じる';
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        node.collapsed = !node.collapsed;
        this.render();
      });
      row.append(twisty);
    }

    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = 'visibility';
    visibility.textContent = node.visible ? '👁' : '🚫';
    visibility.title = node.visible ? '非表示にする' : '表示する';
    visibility.addEventListener('click', (event) => {
      event.stopPropagation();
      node.visible = !node.visible;
      this.callbacks.onChanged();
      this.render();
    });

    const name = document.createElement('span');
    name.className = 'name';
    const pen = node.id === this.doc.activeLayerId && node.id !== this.doc.selectedId ? '✏ ' : '';
    // The downward arrow reads the way the relationship does: this layer points at the one
    // below it as its mask.
    const clip = node.clipped ? '↳ ' : '';
    name.textContent = `${pen}${clip}${node.kind === 'folder' ? '📁 ' : ''}${node.name}`;
    name.title = 'ダブルクリックで名前を変更';
    name.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginRename(node, name);
    });

    // Opacity and blend mode live in the properties strip above the list rather than on
    // every row: at this width a per-row slider crowds out the layer name, and both only
    // ever apply to the selected node anyway.
    const badge = document.createElement('span');
    badge.className = 'layerBadge';
    badge.textContent = describeBadge(node.blend, node.opacity);

    row.append(visibility, name, badge);
    row.addEventListener('click', () => this.callbacks.onSelect(node.id));
    this.bindDragAndDrop(row, node);

    return row;
  }

  private beginRename(node: DocNode, label: HTMLElement): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'renameInput';
    input.value = node.name;

    const commit = () => {
      const value = input.value.trim();
      if (value) node.name = value;
      this.render();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') this.render();
    });
    input.addEventListener('click', (event) => event.stopPropagation());

    label.replaceWith(input);
    input.focus();
    input.select();
  }

  private bindDragAndDrop(row: HTMLElement, node: DocNode): void {
    row.addEventListener('dragstart', (event) => {
      this.dragId = node.id;
      event.dataTransfer?.setData('text/plain', String(node.id));
      row.classList.add('dragging');
    });

    row.addEventListener('dragend', () => {
      this.dragId = null;
      row.classList.remove('dragging');
      this.render();
    });

    row.addEventListener('dragover', (event) => {
      if (this.dragId === null || this.dragId === node.id) return;
      event.preventDefault();

      const bounds = row.getBoundingClientRect();
      const position = dropPosition(event.clientY, bounds, node.kind === 'folder');
      row.dataset['drop'] = position;
    });

    row.addEventListener('dragleave', () => {
      delete row.dataset['drop'];
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const dragged = this.dragId;
      delete row.dataset['drop'];
      if (dragged === null || dragged === node.id) return;

      const bounds = row.getBoundingClientRect();
      const position = dropPosition(event.clientY, bounds, node.kind === 'folder');

      if (position === 'inside' && node.kind === 'folder') {
        // Dropping onto a folder puts the node on top of that folder's contents.
        this.doc.move(dragged, node.id, node.childIds.length);
      } else {
        const siblings = node.parentId === null ? this.doc.rootIds : folderChildren(this.doc, node.parentId);
        const targetIndex = siblings.indexOf(node.id);
        // The list runs top-first while the model runs bottom-first, so dropping "above"
        // a row means inserting *after* it in document order.
        const insertAt = position === 'above' ? targetIndex + 1 : targetIndex;
        this.doc.move(dragged, node.parentId, insertAt);
      }

      this.callbacks.onChanged();
      this.render();
    });
  }
}

/** Compact right-aligned summary, shown only when a node differs from the plain default. */
function describeBadge(blend: LayerBlendMode, opacity: number): string {
  const parts: string[] = [];
  if (blend !== 'normal') parts.push(BLEND_MODE_LABELS[blend]);
  if (opacity < 1) parts.push(`${Math.round(opacity * 100)}%`);
  return parts.join(' ');
}

type DropPosition = 'above' | 'below' | 'inside';

function dropPosition(clientY: number, bounds: DOMRect, allowInside: boolean): DropPosition {
  const ratio = (clientY - bounds.top) / bounds.height;
  if (allowInside && ratio > 0.25 && ratio < 0.75) return 'inside';
  return ratio < 0.5 ? 'above' : 'below';
}

function folderChildren(doc: PaintDocument, folderId: NodeId): NodeId[] {
  const folder = doc.nodes.get(folderId);
  return folder?.kind === 'folder' ? folder.childIds : doc.rootIds;
}
