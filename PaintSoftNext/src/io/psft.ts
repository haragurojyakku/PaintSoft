import { EDITOR_COLUMN_X, PaintDocument, type DocNode, type NodeId } from '../core/Document';
import { isBlendMode } from '../engine/blendModes';
import type { Engine } from '../engine/Engine';

/**
 * Read/write support for v1's `.psft` project format, unchanged, so files move both ways
 * between the two versions.
 *
 * v1 stores the layer stack as a node graph: every top-level node has an `out` edge, and
 * compositing order is "hop count to the output node, then geometric distance from it".
 * v2 models the stack as a plain tree instead, so loading resolves that ordering into the
 * tree and saving synthesises node positions that reproduce the same order when v1 reads
 * the file back. Node positions are therefore regenerated rather than preserved — they are
 * cosmetic editor coordinates, and v2 has no node editor to place them by hand.
 */

const FORMAT = 'paintsoft-project';

type PsftOut = { kind: 'output' } | { kind: 'layer'; layerId: number } | null;

/**
 * Opacity and blend mode are v2 additions. v1 reads named fields and ignores anything it
 * does not know, so writing them keeps files loadable by both versions — v1 simply renders
 * every layer opaque and in normal mode, as it always did.
 */
interface PsftExtras {
  opacity?: number;
  blend?: string;
  /**
   * The node's real editor X.
   *
   * The standard `x` field is deliberately written as a constant instead: v1 orders nodes
   * by their *2D* distance from the output anchor, so a node dragged to the right would
   * move down v1's stack. Pinning `x` makes that distance monotonic in Y, which is exactly
   * v2's rule, so both versions agree on the order — and the user's actual horizontal
   * placement rides along here, where v1 harmlessly ignores it.
   */
  editorX?: number;
  clipped?: boolean;
  /** Layer mask as a greyscale PNG data URL, absent when the layer has none. */
  mask?: string;
}

interface PsftLayer extends PsftExtras {
  id: number;
  name: string;
  visible: boolean;
  connected: boolean;
  out: PsftOut;
  x: number;
  y: number;
  folderId: number | null;
  url: string;
}

interface PsftFolder extends PsftExtras {
  id: number;
  name: string;
  x: number;
  y: number;
  out: PsftOut;
  visible: boolean;
  collapsed: boolean;
  folderId: number | null;
  childIds: number[];
}

export interface PsftFile {
  format: typeof FORMAT;
  version: 1;
  width: number;
  height: number;
  bgColor: string;
  activeLayerId: number | null;
  nextNodeId: number;
  folders: PsftFolder[];
  layers: PsftLayer[];
}

// v1's node-editor geometry, mirrored here so its ordering comparator can be reproduced
// when reading a file back.
const NODE_WIDTH = 220;
const NODE_PORT_Y = 16;
const OUTPUT_ANCHOR = { x: 12, y: 12 + 16 };

// -------------------------------------------------------------------- save

export function serializeProject(doc: PaintDocument, engine: Engine, bgColor: string): PsftFile {
  const layers: PsftLayer[] = [];
  const folders: PsftFolder[] = [];

  for (const { node } of doc.flatten()) {
    const isRoot = node.parentId === null;
    // See PsftExtras.editorX for why the canonical X is pinned rather than written through.
    const x = EDITOR_COLUMN_X;
    const y = node.editorY;
    // Only top-level nodes carry a graph edge; nodes inside a folder are reached through
    // their parent's childIds instead.
    const out: PsftOut = isRoot ? { kind: 'output' } : null;

    if (node.kind === 'folder') {
      folders.push({
        id: node.id,
        name: node.name,
        x,
        y,
        out,
        visible: node.visible,
        collapsed: node.collapsed,
        folderId: node.parentId,
        childIds: [...node.childIds],
        opacity: node.opacity,
        blend: node.blend,
        editorX: node.editorX,
      clipped: node.clipped,
      });
      continue;
    }

    layers.push({
      id: node.id,
      name: node.name,
      visible: node.visible,
      connected: isRoot,
      out,
      x,
      y,
      folderId: node.parentId,
      url: layerToDataUrl(engine, node.engineLayerId),
      opacity: node.opacity,
      blend: node.blend,
      editorX: node.editorX,
      clipped: node.clipped,
      ...(engine.hasMask(node.engineLayerId)
        ? { mask: imageToDataUrl(engine.exportLayerMaskImageData(node.engineLayerId)) }
        : {}),
    });
  }

  const highestId = Math.max(0, ...[...doc.nodes.keys()]);

  return {
    format: FORMAT,
    version: 1,
    width: engine.width,
    height: engine.height,
    bgColor,
    activeLayerId: doc.activeLayerId,
    nextNodeId: highestId + 1,
    folders,
    layers,
  };
}

function layerToDataUrl(engine: Engine, engineLayerId: number): string {
  return imageToDataUrl(engine.exportLayerImageData(engineLayerId));
}

function imageToDataUrl(imageData: ImageData | null): string {
  if (!imageData) return '';

  const surface = document.createElement('canvas');
  surface.width = imageData.width;
  surface.height = imageData.height;
  surface.getContext('2d')?.putImageData(imageData, 0, 0);
  return surface.toDataURL('image/png');
}

// -------------------------------------------------------------------- load

export interface LoadedProject {
  bgColor: string;
  width: number;
  height: number;
  /** Layers v1 would not have composited because they were never wired to the output. */
  disconnectedLayerCount: number;
}

export async function loadProject(file: unknown, doc: PaintDocument, engine: Engine): Promise<LoadedProject> {
  const project = file as PsftFile;
  if (!project || project.format !== FORMAT) {
    throw new Error('対応していないプロジェクトファイルです（.psft を指定してください）');
  }

  const width = Math.max(1, Math.floor(project.width) || engine.width);
  const height = Math.max(1, Math.floor(project.height) || engine.height);

  const layers = project.layers ?? [];
  const folders = project.folders ?? [];
  const byId = new Map<number, PsftLayer | PsftFolder>();
  for (const layer of layers) byId.set(layer.id, layer);
  for (const folder of folders) byId.set(folder.id, folder);

  doc.reset();
  engine.resetLayers();
  engine.resizeDocument(width, height, { mode: 'crop', anchorX: 0, anchorY: 0 });

  // Decode every layer bitmap up front; uploads then happen in tree order.
  const bitmaps = new Map<number, ImageBitmap | null>(
    await Promise.all(
      layers.map(async (layer) => [layer.id, await decode(layer.url)] as const),
    ),
  );
  const maskBitmaps = new Map<number, ImageBitmap | null>(
    await Promise.all(
      layers.map(async (layer) => [layer.id, await decode(layer.mask ?? '')] as const),
    ),
  );

  const rootOrder = orderRootNodes(layers, folders, byId);
  const placed = new Set<number>();

  // v1 ids and v2 ids are allocated independently, so the active-layer reference has to be
  // translated rather than copied across.
  const idMap = new Map<number, NodeId>();
  const remap = (oldId: number, newId: NodeId) => {
    idMap.set(oldId, newId);
    const source = byId.get(oldId);
    if (source) sourceByNodeId.set(newId, source);
  };

  /** New document node id -> the file record it came from, for the position pass below. */
  const sourceByNodeId = new Map<NodeId, PsftLayer | PsftFolder>();

  const addNode = (source: PsftLayer | PsftFolder, parentId: NodeId | null): void => {
    placed.add(source.id);

    if (isFolder(source)) {
      const folder = doc.createFolder(source.name, parentId);
      folder.visible = source.visible !== false;
      folder.collapsed = source.collapsed === true;
      applyExtras(folder, source);
      remap(source.id, folder.id);

      for (const childId of source.childIds ?? []) {
        const child = byId.get(childId);
        if (child) addNode(child, folder.id);
      }
      return;
    }

    const engineLayer = engine.createLayer();
    const bitmap = bitmaps.get(source.id);
    if (bitmap) engine.uploadLayerImage(engineLayer.id, bitmap);

    const maskBitmap = maskBitmaps.get(source.id);
    if (maskBitmap) {
      engine.createLayerMask(engineLayer.id, 'reveal');
      engine.uploadLayerMask(engineLayer.id, maskBitmap);
    }

    const layerNode = doc.createLayer(engineLayer.id, source.name, parentId);
    layerNode.visible = source.visible !== false;
    applyExtras(layerNode, source);
    remap(source.id, layerNode.id);
  };

  for (const node of rootOrder) addNode(node, null);

  // Anything the graph never routed to the output is still real artwork; keep it as a
  // hidden bottom layer rather than silently dropping the user's pixels.
  let disconnectedLayerCount = 0;
  for (const layer of layers) {
    if (placed.has(layer.id)) continue;
    disconnectedLayerCount += 1;
    const engineLayer = engine.createLayer();
    const bitmap = bitmaps.get(layer.id);
    if (bitmap) engine.uploadLayerImage(engineLayer.id, bitmap);
    const node = doc.createLayer(engineLayer.id, layer.name, null);
    node.visible = false;
    // Unrouted layers sit below everything that was routed.
    doc.move(node.id, null, 0);
  }

  restoreEditorPositions(doc, sourceByNodeId);

  for (const bitmap of bitmaps.values()) bitmap?.close();
  for (const bitmap of maskBitmaps.values()) bitmap?.close();

  const mappedActive = project.activeLayerId != null ? idMap.get(project.activeLayerId) : undefined;
  doc.activeLayerId = mappedActive ?? doc.firstLayer()?.id ?? null;
  doc.selectedId = doc.activeLayerId;

  return {
    bgColor: typeof project.bgColor === 'string' ? project.bgColor : '#ffffff',
    width,
    height,
    disconnectedLayerCount,
  };
}

function isFolder(node: PsftLayer | PsftFolder): node is PsftFolder {
  return Array.isArray((node as PsftFolder).childIds);
}

/** Applies the v2-only fields, falling back to v1's implicit "opaque, normal". */
function applyExtras(node: DocNode, source: PsftExtras): void {
  if (typeof source.opacity === 'number' && Number.isFinite(source.opacity)) {
    node.opacity = Math.max(0, Math.min(1, source.opacity));
  }
  if (isBlendMode(source.blend)) node.blend = source.blend;
  node.clipped = source.clipped === true;
}

/**
 * Restores editor coordinates once the whole tree exists.
 *
 * It has to be a second pass: creating a top-level node re-lays-out the column, so
 * positions applied while nodes were still being added would be overwritten by the next
 * one. Children are skipped — they are drawn as rows inside their parent's box, so any
 * stored position for them is meaningless here.
 *
 * If the restored Y ordering disagrees with the stack order (possible for a v1 file, whose
 * ordering also depended on X), the order wins and the column is simply re-laid-out: an
 * editor whose boxes contradict the actual compositing order would be worse than one whose
 * boxes moved.
 */
function restoreEditorPositions(
  doc: PaintDocument,
  sources: Map<NodeId, PsftLayer | PsftFolder>,
): void {
  for (const id of doc.rootIds) {
    const node = doc.nodes.get(id);
    const source = sources.get(id);
    if (!node || !source) continue;

    if (Number.isFinite(source.editorX)) node.editorX = Math.max(0, source.editorX!);
    else if (Number.isFinite(source.x)) node.editorX = Math.max(0, source.x);
    if (Number.isFinite(source.y)) node.editorY = Math.max(0, source.y);
  }

  // rootIds runs bottom-first, so Y must be strictly decreasing along it.
  let previousY = Infinity;
  for (const id of doc.rootIds) {
    const y = doc.nodes.get(id)?.editorY ?? 0;
    if (y >= previousY) {
      doc.relayoutEditorPositions();
      return;
    }
    previousY = y;
  }
}

async function decode(url: string): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

/**
 * Reproduces v1's `getOrderedRoutableNodes`: nodes that reach the output node, sorted by
 * hop count descending (farthest from the output composites first, i.e. at the bottom),
 * then by geometric distance descending, then by id. The result is bottom-to-top, which is
 * the order this document model stores siblings in.
 */
function orderRootNodes(
  layers: PsftLayer[],
  folders: PsftFolder[],
  byId: Map<number, PsftLayer | PsftFolder>,
): (PsftLayer | PsftFolder)[] {
  const routable = [...layers, ...folders].filter((node) => node.folderId == null);

  const memo = new Map<number, number | null>();
  const visiting = new Set<number>();

  const hopToOutput = (node: PsftLayer | PsftFolder | undefined): number | null => {
    if (!node?.out) return null;
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) return null;
    visiting.add(node.id);

    let hops: number | null = null;
    if (node.out.kind === 'output') {
      hops = 0;
    } else if (node.out.kind === 'layer') {
      const next = hopToOutput(byId.get(node.out.layerId));
      if (next != null) hops = next + 1;
    }

    visiting.delete(node.id);
    memo.set(node.id, hops);
    return hops;
  };

  const distanceSquared = (node: PsftLayer | PsftFolder): number => {
    const dx = (node.x ?? 0) + NODE_WIDTH - OUTPUT_ANCHOR.x;
    const dy = (node.y ?? 0) + NODE_PORT_Y - OUTPUT_ANCHOR.y;
    return dx * dx + dy * dy;
  };

  return routable
    .map((node) => ({ node, hop: hopToOutput(node) }))
    .filter((entry): entry is { node: PsftLayer | PsftFolder; hop: number } => entry.hop != null)
    .sort((a, b) => {
      if (a.hop !== b.hop) return b.hop - a.hop;
      const da = distanceSquared(a.node);
      const db = distanceSquared(b.node);
      if (da !== db) return db - da;
      return a.node.id - b.node.id;
    })
    .map((entry) => entry.node);
}
