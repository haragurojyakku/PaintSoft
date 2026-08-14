using System.IO;
using System.IO.Compression;

namespace PaintSoft.Desktop.ClipFormat;

/// <summary>
/// Decodes a layer's 256x256 zlib-compressed tile grid into a single BGRA32 pixel buffer.
/// Only the standard 1(alpha)+4(BGRx) channel packing used by ordinary raster layers is
/// supported; masks and other single-channel packings are skipped (return null).
/// </summary>
internal static class ClipLayerRasterizer
{
    private const int TileSize = 256;

    public static (byte[] Bgra, int Width, int Height)? Decode(OffscreenAttribute attr, List<byte[]?> tiles)
    {
        if (!attr.IsColorLayer)
            return null; // mask / grayscale layer — not rendered in this MVP.

        if (attr.BlockGridWidth * attr.BlockGridHeight != tiles.Count)
            return null;

        int width = attr.BitmapWidth;
        int height = attr.BitmapHeight;
        var buffer = new byte[width * height * 4];

        // Fill with the layer's default background: opaque white or fully transparent.
        if (attr.DefaultFillWhite)
        {
            for (int i = 0; i < buffer.Length; i += 4)
            {
                buffer[i + 0] = 255; // B
                buffer[i + 1] = 255; // G
                buffer[i + 2] = 255; // R
                buffer[i + 3] = 255; // A
            }
        }
        // else: already zero-initialized = transparent black.

        const int pixelsPerTile = TileSize * TileSize;

        for (int ty = 0; ty < attr.BlockGridHeight; ty++)
        {
            for (int tx = 0; tx < attr.BlockGridWidth; tx++)
            {
                byte[]? tile = tiles[ty * attr.BlockGridWidth + tx];
                if (tile is null)
                    continue; // leave default fill for this tile

                byte[] decompressed;
                try
                {
                    decompressed = ZlibInflate(tile);
                }
                catch (InvalidDataException)
                {
                    continue;
                }

                if (decompressed.Length != 5 * pixelsPerTile)
                    continue;

                int rowsInTile = Math.Min(TileSize, height - ty * TileSize);
                int colsInTile = Math.Min(TileSize, width - tx * TileSize);
                if (rowsInTile <= 0 || colsInTile <= 0)
                    continue;

                for (int y = 0; y < rowsInTile; y++)
                {
                    int destRowStart = ((ty * TileSize + y) * width + tx * TileSize) * 4;
                    int srcRowStart = y * TileSize;
                    int srcBgrxRowStart = pixelsPerTile + srcRowStart * 4;

                    for (int x = 0; x < colsInTile; x++)
                    {
                        byte a = decompressed[srcRowStart + x];
                        int srcBgrx = srcBgrxRowStart + x * 4;
                        int dest = destRowStart + x * 4;

                        buffer[dest + 0] = decompressed[srcBgrx + 0]; // B
                        buffer[dest + 1] = decompressed[srcBgrx + 1]; // G
                        buffer[dest + 2] = decompressed[srcBgrx + 2]; // R
                        buffer[dest + 3] = a;                          // A
                    }
                }
            }
        }

        return (buffer, width, height);
    }

    private static byte[] ZlibInflate(byte[] compressed)
    {
        using var input = new MemoryStream(compressed);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        zlib.CopyTo(output);
        return output.ToArray();
    }
}
