/**
 * The contract the WPF desktop shell drives over WebView2.
 *
 * The shell owns all `.clip` parsing and writing in C#; the web side only exchanges
 * decoded layers with it, as full-size PNG data URLs. Both entry points are installed as
 * globals because `ExecuteScriptAsync` can only reach `window`.
 *
 * `getClipExportDocument` must stay **synchronous** — the shell serialises whatever the
 * script expression evaluates to, so returning a promise would hand it an empty object.
 */

export interface ClipLayerDto {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  /** 'data:image/png;base64,...' */
  png: string;
}

export interface ClipDocumentDto {
  width: number;
  height: number;
  layers: ClipLayerDto[];
}

export interface ClipBridgeHost {
  loadClipDocument(dto: ClipDocumentDto): Promise<void>;
  getClipExportDocument(): ClipDocumentDto;
}

export function installClipBridge(host: ClipBridgeHost): void {
  Reflect.set(window, 'loadClipDocument', (dto: ClipDocumentDto) => {
    void host.loadClipDocument(dto);
  });
  Reflect.set(window, 'getClipExportDocument', () => host.getClipExportDocument());
}

export function imageDataToPngDataUrl(image: ImageData | null): string {
  if (!image) return '';
  const surface = document.createElement('canvas');
  surface.width = image.width;
  surface.height = image.height;
  surface.getContext('2d')?.putImageData(image, 0, 0);
  return surface.toDataURL('image/png');
}

/**
 * Decodes a layer's PNG and places it on a full-canvas surface at its offset.
 *
 * `.clip` layers carry their own bounds, which are usually smaller than the document,
 * whereas engine layers are always canvas-sized — so the offset has to be baked in during
 * the upload rather than tracked afterwards.
 */
export async function decodeLayerOntoCanvas(
  layer: ClipLayerDto,
  documentWidth: number,
  documentHeight: number,
): Promise<OffscreenCanvas | null> {
  if (!layer.png) return null;

  try {
    const response = await fetch(layer.png);
    const bitmap = await createImageBitmap(await response.blob());

    const surface = new OffscreenCanvas(documentWidth, documentHeight);
    surface.getContext('2d')?.drawImage(bitmap, layer.x || 0, layer.y || 0);
    bitmap.close();
    return surface;
  } catch {
    return null;
  }
}
