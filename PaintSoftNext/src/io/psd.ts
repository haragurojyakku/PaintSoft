import type { PaintDocument } from '../core/Document';
import { PSD_BLEND_KEYS, type LayerBlendMode } from '../engine/blendModes';
import type { Engine } from '../engine/Engine';

/**
 * PSD writer — no external library, big-endian, PackBits-compressed.
 *
 * Two things it does that v1's writer did not:
 *
 *  - **Folders survive as real PSD groups.** A group is encoded as a bounding divider
 *    layer, then its children, then a header layer carrying an `lsct` block; v1 flattened
 *    folders away because its own model had no group compositing to preserve.
 *  - **Channels are PackBits-compressed** instead of raw. Illustration layers are mostly
 *    transparent, which RLE collapses to almost nothing — the difference between a file
 *    of tens of megabytes per layer and one of a few hundred kilobytes.
 *
 * Layer opacity and blend mode are carried across too, using PSD's own four-character
 * blend keys. Still simplified: every layer is written at full canvas bounds rather than
 * trimmed to the area it actually uses.
 */

type SectionType =
  /** An ordinary pixel layer. */
  | 0
  /** Open folder header. */
  | 1
  /** Closed folder header. */
  | 2
  /** The divider that marks where a group's contents begin. */
  | 3;

interface PsdLayer {
  name: string;
  visible: boolean;
  /** 0..255, PSD's own scale. */
  opacity: number;
  blend: LayerBlendMode;
  clipped: boolean;
  image: ImageData | null;
  /** Greyscale layer mask, written as PSD's channel -2. */
  mask: ImageData | null;
  sectionType: SectionType;
}

export function exportPsd(doc: PaintDocument, engine: Engine): Blob {
  const width = engine.width;
  const height = engine.height;
  const layers = collectLayers(doc, engine);

  const file = new ByteWriter();

  // --- File header -------------------------------------------------------
  file.ascii('8BPS');
  file.u16(1); // version
  file.bytes(new Uint8Array(6)); // reserved
  file.u16(3); // channels in the merged image: R, G, B
  file.u32(height);
  file.u32(width);
  file.u16(8); // bits per channel
  file.u16(3); // colour mode: RGB

  file.u32(0); // colour mode data
  file.u32(0); // image resources

  // --- Layer and mask information ----------------------------------------
  const layerInfo = buildLayerInfo(layers, width, height);
  const layerAndMask = new ByteWriter();
  layerAndMask.u32(layerInfo.length);
  layerAndMask.writer(layerInfo);
  layerAndMask.u32(0); // global layer mask info
  file.u32(layerAndMask.length);
  file.writer(layerAndMask);

  // --- Merged image ------------------------------------------------------
  // Photoshop shows this when it does not want to recomposite, and other readers use it
  // as the flattened preview, so it has to agree with what the app displays.
  const merged = engine.exportImageData();
  file.u16(1); // PackBits
  const planes: Uint8Array[] = [];
  const rowCounts = new ByteWriter();
  for (let channel = 0; channel < 3; channel += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = extractRow(merged, channel, y, width);
      const packed = packBits(row);
      rowCounts.u16(packed.length);
      planes.push(packed);
    }
  }
  file.writer(rowCounts);
  for (const plane of planes) file.bytes(plane);

  return file.toBlob('image/vnd.adobe.photoshop');
}

/**
 * Flattens the document into PSD's bottom-to-top layer list, wrapping each folder in the
 * divider/header pair that Photoshop reads back as a group.
 */
function collectLayers(doc: PaintDocument, engine: Engine): PsdLayer[] {
  const out: PsdLayer[] = [];

  const walk = (ids: readonly number[]): void => {
    for (const id of ids) {
      const node = doc.nodes.get(id);
      if (!node) continue;

      if (node.kind === 'layer') {
        out.push({
          name: node.name,
          visible: node.visible,
          opacity: Math.round(node.opacity * 255),
          blend: node.blend,
          clipped: node.clipped,
          image: engine.exportLayerImageData(node.engineLayerId),
          mask: engine.exportLayerMaskImageData(node.engineLayerId),
          sectionType: 0,
        });
        continue;
      }

      out.push({
        name: '</Layer group>',
        visible: true,
        opacity: 255,
        blend: 'normal',
        clipped: false,
        image: null,
        mask: null,
        sectionType: 3,
      });
      walk(node.childIds);
      out.push({
        name: node.name,
        visible: node.visible,
        opacity: Math.round(node.opacity * 255),
        blend: node.blend,
        clipped: node.clipped,
        image: null,
        mask: null,
        sectionType: node.collapsed ? 2 : 1,
      });
    }
  };

  walk(doc.rootIds);
  return out;
}

function buildLayerInfo(layers: readonly PsdLayer[], width: number, height: number): ByteWriter {
  const info = new ByteWriter();
  info.i16(layers.length);

  const channelData: ByteWriter[] = [];

  for (const layer of layers) {
    const hasPixels = layer.image !== null;

    // Group headers and dividers carry no pixels; an empty rect is how PSD says so.
    if (hasPixels) {
      info.u32(0);
      info.u32(0);
      info.u32(height);
      info.u32(width);
    } else {
      info.u32(0);
      info.u32(0);
      info.u32(0);
      info.u32(0);
    }

    // Mask (-2) first, then alpha (-1), then R/G/B — ascending channel id, which is the
    // order PSD readers expect the matching data blocks to appear in further down the file.
    const hasMask = hasPixels && layer.mask !== null;
    const channels = hasMask ? [-2, -1, 0, 1, 2] : [-1, 0, 1, 2];
    info.u16(channels.length);

    for (const channel of channels) {
      const data = new ByteWriter();
      // A mask is a single greyscale channel; any of its RGB bytes carries the value.
      const sourceImage = channel === -2 ? layer.mask : layer.image;

      if (hasPixels && sourceImage) {
        data.u16(1); // PackBits
        const packedRows: Uint8Array[] = [];
        const counts = new ByteWriter();
        for (let y = 0; y < height; y += 1) {
          const packed = packBits(extractRow(sourceImage, channelToOffset(channel), y, width));
          counts.u16(packed.length);
          packedRows.push(packed);
        }
        data.writer(counts);
        for (const row of packedRows) data.bytes(row);
      } else {
        data.u16(0); // raw, and there are no rows to write
      }

      info.i16(channel);
      info.u32(data.length);
      channelData.push(data);
    }

    info.ascii('8BIM');
    info.ascii(PSD_BLEND_KEYS[layer.blend]);
    info.u8(layer.opacity);
    info.u8(layer.clipped ? 1 : 0);
    info.u8(layer.visible ? 0 : 2); // bit 1 set means hidden
    info.u8(0); // filler

    const extra = new ByteWriter();
    if (hasMask) {
      // Layer mask data: the rect the mask covers, its default value outside that rect,
      // and flags. 20 bytes total for the non-extended form.
      extra.u32(20);
      extra.u32(0);
      extra.u32(0);
      extra.u32(height);
      extra.u32(width);
      extra.u8(255); // default colour outside the rect: fully revealed
      extra.u8(0); // flags
      extra.u16(0); // padding
    } else {
      extra.u32(0);
    }
    extra.u32(0); // layer blending ranges
    extra.pascalString(layer.name, 4);

    if (layer.sectionType !== 0) {
      extra.ascii('8BIM');
      extra.ascii('lsct');
      extra.u32(4);
      extra.u32(layer.sectionType);
    }

    // Layer names in the Pascal-string field above are MacRoman-ish bytes, which cannot
    // represent Japanese. 'luni' carries the real UTF-16 name and is what every modern
    // reader prefers.
    extra.ascii('8BIM');
    extra.ascii('luni');
    const unicode = new ByteWriter();
    unicode.u32(layer.name.length);
    for (const unit of utf16Units(layer.name)) unicode.u16(unit);
    extra.u32(unicode.length);
    extra.writer(unicode);
    if (unicode.length % 2 !== 0) extra.u8(0);

    info.u32(extra.length);
    info.writer(extra);
  }

  for (const data of channelData) info.writer(data);

  // The layer info block must be even-length.
  if (info.length % 2 !== 0) info.u8(0);
  return info;
}

/** RGBA byte offset for a PSD channel id. Mask (-2) reads red from its greyscale image. */
function channelToOffset(channel: number): number {
  if (channel === -2) return 0;
  return channel === -1 ? 3 : channel;
}

function extractRow(image: ImageData, channelOffset: number, y: number, width: number): Uint8Array {
  const row = new Uint8Array(width);
  let source = y * image.width * 4 + channelOffset;
  for (let x = 0; x < width; x += 1) {
    row[x] = image.data[source]!;
    source += 4;
  }
  return row;
}

function utf16Units(text: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < text.length; i += 1) units.push(text.charCodeAt(i));
  return units;
}

/**
 * PackBits (PSD compression mode 1): runs of 3+ identical bytes become a negative count
 * plus the repeated byte; everything else is copied literally behind a positive count.
 * Both run kinds cap at 128 bytes, which is what the signed length byte can address.
 */
export function packBits(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;

  while (i < input.length) {
    let runLength = 1;
    while (
      i + runLength < input.length &&
      runLength < 128 &&
      input[i + runLength] === input[i]
    ) {
      runLength += 1;
    }

    if (runLength >= 3) {
      out.push(257 - runLength, input[i]!);
      i += runLength;
      continue;
    }

    // Gather literals until a 3-run starts or the 128-byte budget is spent.
    const start = i;
    let literal = 0;
    while (i < input.length && literal < 128) {
      const isRunStart =
        i + 2 < input.length && input[i] === input[i + 1] && input[i] === input[i + 2];
      if (isRunStart) break;
      i += 1;
      literal += 1;
    }

    out.push(literal - 1);
    for (let k = start; k < start + literal; k += 1) out.push(input[k]!);
  }

  return new Uint8Array(out);
}

/** Big-endian byte accumulator. */
class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  u8(value: number): void {
    this.bytes(new Uint8Array([value & 0xff]));
  }

  u16(value: number): void {
    this.bytes(new Uint8Array([(value >> 8) & 0xff, value & 0xff]));
  }

  i16(value: number): void {
    this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value: number): void {
    this.bytes(new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]));
  }

  ascii(text: string): void {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    this.bytes(out);
  }

  /** Length-prefixed string padded so the whole field is a multiple of `padTo`. */
  pascalString(text: string, padTo: number): void {
    const encoded = new Uint8Array(Math.min(255, text.length));
    for (let i = 0; i < encoded.length; i += 1) {
      const code = text.charCodeAt(i);
      encoded[i] = code < 256 ? code : 0x3f; // '?' for anything MacRoman cannot hold
    }

    const totalLength = 1 + encoded.length;
    const padding = (padTo - (totalLength % padTo)) % padTo;

    this.u8(encoded.length);
    this.bytes(encoded);
    if (padding > 0) this.bytes(new Uint8Array(padding));
  }

  bytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.total += data.length;
  }

  writer(other: ByteWriter): void {
    for (const chunk of other.chunks) this.bytes(chunk);
  }

  toBlob(type: string): Blob {
    return new Blob(this.chunks as BlobPart[], { type });
  }
}
