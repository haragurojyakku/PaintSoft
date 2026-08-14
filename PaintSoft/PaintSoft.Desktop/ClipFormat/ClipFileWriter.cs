using System.Buffers.Binary;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Data.Sqlite;

namespace PaintSoft.Desktop.ClipFormat;

/// <summary>
/// Writes a best-effort ".clip"-shaped file: the same outer CSFCHUNK container, the same
/// SQLite Canvas/Layer/Offscreen/Mipmap/MipmapInfo tables, and the same 256px zlib-tile
/// pixel encoding that <see cref="ClipFileReader"/>/<see cref="ClipLayerRasterizer"/>
/// understand on the way back in — this is literally that reader run in reverse.
///
/// This is NOT a real CLIP STUDIO PAINT writer. There is no public specification, and a
/// genuine CSP-authored file almost certainly carries many more tables/records than the
/// handful this reverse-engineered reader understands (document metadata, undo history,
/// thumbnails, color profiles, ...). Round-tripping through this app's own reader is
/// guaranteed (see ClipFileReader.Load); opening the result in real CLIP STUDIO PAINT is
/// not, and is expected to fail.
/// </summary>
public static class ClipFileWriter
{
    private const int TileSize = 256;

    private static readonly byte[] BlockDataBeginChunk = Encoding.BigEndianUnicode.GetBytes("BlockDataBeginChunk");
    private static readonly byte[] BlockDataEndChunk = Encoding.BigEndianUnicode.GetBytes("BlockDataEndChunk");

    public static void Save(string path, ClipDocument doc)
    {
        string tempDb = Path.Combine(Path.GetTempPath(), $"paintsoft_clip_write_{Guid.NewGuid():N}.sqlite");
        try
        {
            var extaChunks = new List<(byte[] ChunkId, byte[] Data)>();
            BuildSqlite(tempDb, doc, extaChunks);
            byte[] sqliteBytes = File.ReadAllBytes(tempDb);

            using var output = new FileStream(path, FileMode.Create, FileAccess.Write);
            WriteContainer(output, sqliteBytes, extaChunks);
        }
        finally
        {
            try { File.Delete(tempDb); } catch { /* best effort cleanup */ }
        }
    }

    private static void BuildSqlite(string dbPath, ClipDocument doc, List<(byte[] ChunkId, byte[] Data)> extaChunks)
    {
        // Pooling=False: without it, Microsoft.Data.Sqlite keeps the native handle open in a
        // pool after Dispose(), so the immediate File.ReadAllBytes(dbPath) in Save() fails
        // with a sharing violation.
        using var conn = new SqliteConnection($"Data Source={dbPath};Pooling=False");
        conn.Open();

        using (var pragma = conn.CreateCommand())
        {
            // Force everything into the single main db file (no separate -wal/-shm), since
            // we read the file back as raw bytes right after this connection closes.
            pragma.CommandText = "PRAGMA journal_mode=DELETE;";
            pragma.ExecuteNonQuery();
        }

        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                CREATE TABLE Canvas (CanvasWidth INTEGER, CanvasHeight INTEGER, CanvasRootFolder INTEGER);
                CREATE TABLE Layer (
                    MainId INTEGER PRIMARY KEY, LayerName TEXT, LayerFolder INTEGER,
                    LayerFirstChildIndex INTEGER, LayerNextIndex INTEGER, LayerVisibility INTEGER,
                    LayerRenderMipmap INTEGER, LayerOffsetX INTEGER, LayerOffsetY INTEGER,
                    LayerRenderOffscrOffsetX INTEGER, LayerRenderOffscrOffsetY INTEGER);
                CREATE TABLE Offscreen (MainId INTEGER PRIMARY KEY, BlockData BLOB, Attribute BLOB);
                CREATE TABLE Mipmap (MainId INTEGER PRIMARY KEY, BaseMipmapInfo INTEGER);
                CREATE TABLE MipmapInfo (MainId INTEGER PRIMARY KEY, Offscreen INTEGER);";
            cmd.ExecuteNonQuery();
        }

        using var tx = conn.BeginTransaction();

        long nextId = 1;
        long rootFolderId = nextId++;

        int n = doc.Layers.Count;
        var layerIds = new long[n];
        for (int i = 0; i < n; i++) layerIds[i] = nextId++;

        // doc.Layers is back-to-front (index 0 = bottom-most, see ClipFileReader.Load /
        // getClipExportDocument in app.js). ClipFileReader walks FirstChildIndex -> NextIndex
        // front-to-back and then reverses, so the chain we write here must run from the
        // top-most (last array element) layer down to the bottom-most (first element).
        for (int i = 0; i < n; i++)
        {
            var layer = doc.Layers[i];
            long layerId = layerIds[i];
            long? nextIndex = i > 0 ? layerIds[i - 1] : null;

            long offscreenId = nextId++;
            long mipmapInfoId = nextId++;
            long mipmapId = nextId++;

            byte[] chunkId = Guid.NewGuid().ToByteArray();
            byte[] tileStream = EncodeTiles(layer, out int gridW, out int gridH);
            extaChunks.Add((chunkId, tileStream));

            InsertLayer(conn, tx, layerId, layer.Name, isFolder: false,
                firstChildIndex: null, nextIndex: nextIndex, visible: layer.Visible,
                renderMipmap: mipmapId, offsetX: layer.OffsetX, offsetY: layer.OffsetY,
                renderOffX: 0, renderOffY: 0);

            InsertOffscreen(conn, tx, offscreenId, chunkId, BuildAttribute(layer.Width, layer.Height, gridW, gridH));
            InsertMipmapInfo(conn, tx, mipmapInfoId, offscreenId);
            InsertMipmap(conn, tx, mipmapId, mipmapInfoId);
        }

        long? rootFirstChild = n > 0 ? layerIds[n - 1] : null;
        InsertLayer(conn, tx, rootFolderId, "Root", isFolder: true,
            firstChildIndex: rootFirstChild, nextIndex: null, visible: true,
            renderMipmap: null, offsetX: 0, offsetY: 0, renderOffX: 0, renderOffY: 0);

        using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = "INSERT INTO Canvas (CanvasWidth, CanvasHeight, CanvasRootFolder) VALUES ($w, $h, $root)";
            cmd.Parameters.AddWithValue("$w", doc.Width);
            cmd.Parameters.AddWithValue("$h", doc.Height);
            cmd.Parameters.AddWithValue("$root", rootFolderId);
            cmd.ExecuteNonQuery();
        }

        tx.Commit();
    }

    private static void InsertLayer(SqliteConnection conn, SqliteTransaction tx, long id, string name, bool isFolder,
        long? firstChildIndex, long? nextIndex, bool visible, long? renderMipmap,
        int offsetX, int offsetY, int renderOffX, int renderOffY)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"INSERT INTO Layer
            (MainId, LayerName, LayerFolder, LayerFirstChildIndex, LayerNextIndex, LayerVisibility,
             LayerRenderMipmap, LayerOffsetX, LayerOffsetY, LayerRenderOffscrOffsetX, LayerRenderOffscrOffsetY)
            VALUES ($id, $name, $folder, $first, $next, $vis, $mip, $ox, $oy, $rox, $roy)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$name", name);
        cmd.Parameters.AddWithValue("$folder", isFolder ? 1 : 0);
        cmd.Parameters.AddWithValue("$first", (object?)firstChildIndex ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$next", (object?)nextIndex ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$vis", visible ? 1 : 0);
        cmd.Parameters.AddWithValue("$mip", (object?)renderMipmap ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$ox", offsetX);
        cmd.Parameters.AddWithValue("$oy", offsetY);
        cmd.Parameters.AddWithValue("$rox", renderOffX);
        cmd.Parameters.AddWithValue("$roy", renderOffY);
        cmd.ExecuteNonQuery();
    }

    private static void InsertOffscreen(SqliteConnection conn, SqliteTransaction tx, long id, byte[] blockData, byte[] attribute)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO Offscreen (MainId, BlockData, Attribute) VALUES ($id, $bd, $attr)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$bd", blockData);
        cmd.Parameters.AddWithValue("$attr", attribute);
        cmd.ExecuteNonQuery();
    }

    private static void InsertMipmapInfo(SqliteConnection conn, SqliteTransaction tx, long id, long offscreenId)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO MipmapInfo (MainId, Offscreen) VALUES ($id, $off)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$off", offscreenId);
        cmd.ExecuteNonQuery();
    }

    private static void InsertMipmap(SqliteConnection conn, SqliteTransaction tx, long id, long mipmapInfoId)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO Mipmap (MainId, BaseMipmapInfo) VALUES ($id, $info)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$info", mipmapInfoId);
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Builds an Offscreen.Attribute blob matching the layout OffscreenAttribute.TryParse
    /// expects. Fields the reader never validates (info_section_size, the "Parameter"/
    /// "InitColor" string contents, ...) are left empty/zero.
    /// </summary>
    private static byte[] BuildAttribute(int width, int height, int gridWidth, int gridHeight)
    {
        var w = new BigEndianWriter();
        w.I32(16); // headerSize (must be exactly 16)
        w.I32(0); // info_section_size (unused by reader)
        w.I32(0); // extraInfoSectionSize (unused by reader)
        w.I32(0); // unknown
        w.I32(0); // "Parameter" string char count (empty; skipped on read regardless)
        w.I32(width);
        w.I32(height);
        w.I32(gridWidth);
        w.I32(gridHeight);
        for (int i = 0; i < 16; i++)
        {
            // attrs[1]=FirstChannelCount, attrs[2]=SecondChannelCount: IsColorLayer requires 1/4.
            w.I32(i == 1 ? 1 : i == 2 ? 4 : 0);
        }
        w.I32(0); // "InitColor" string char count (empty)
        w.I32(0); // ignored field
        w.I32(0); // defaultFillBlackWhite: 0 = transparent default fill
        return w.ToArray();
    }

    /// <summary>
    /// Splits a layer's PNG into 256x256 tiles, encodes each as [alpha plane][BGRx plane]
    /// (mirroring ClipLayerRasterizer.Decode exactly, in reverse) and zlib-compresses it.
    /// Fully-transparent tiles are written as empty ("no data") records to keep the file
    /// small, matching how the reader's default-fill path expects them.
    /// </summary>
    private static byte[] EncodeTiles(ClipLayer layer, out int gridW, out int gridH)
    {
        int width = layer.Width;
        int height = layer.Height;
        byte[] bgra = DecodePngToBgra(layer.PngBytes, width, height);

        gridW = (width + TileSize - 1) / TileSize;
        gridH = (height + TileSize - 1) / TileSize;

        using var ms = new MemoryStream();
        for (int ty = 0; ty < gridH; ty++)
        {
            for (int tx = 0; tx < gridW; tx++)
            {
                int rowsInTile = Math.Min(TileSize, height - ty * TileSize);
                int colsInTile = Math.Min(TileSize, width - tx * TileSize);

                var plane = new byte[5 * TileSize * TileSize];
                bool hasContent = false;

                for (int y = 0; y < rowsInTile; y++)
                {
                    int srcRowStart = ((ty * TileSize + y) * width + tx * TileSize) * 4;
                    int dstRowStart = y * TileSize;
                    int dstBgrxRowStart = TileSize * TileSize + dstRowStart * 4;

                    for (int x = 0; x < colsInTile; x++)
                    {
                        int src = srcRowStart + x * 4;
                        byte b = bgra[src + 0];
                        byte g = bgra[src + 1];
                        byte r = bgra[src + 2];
                        byte a = bgra[src + 3];
                        if ((a | b | g | r) != 0) hasContent = true;

                        plane[dstRowStart + x] = a;
                        int dstBgrx = dstBgrxRowStart + x * 4;
                        plane[dstBgrx + 0] = b;
                        plane[dstBgrx + 1] = g;
                        plane[dstBgrx + 2] = r;
                    }
                }

                WriteBlockRecord(ms, hasContent ? plane : null);
            }
        }
        return ms.ToArray();
    }

    private static void WriteBlockRecord(Stream output, byte[]? plane)
    {
        byte[] block;
        if (plane is null)
        {
            block = new byte[5 * 4]; // 4 reserved fields + hasData(=0, already zero)
        }
        else
        {
            byte[] compressed = ZlibDeflate(plane);
            // 7 int32 fields (28 bytes: 4 reserved, hasData, subblockLen, 1 more reserved)
            // then the compressed bytes. subblockLen is declared as compressed.Length + 4 —
            // matching ClipBinary.ParseChunkWithBlocks's `block.Length != subblockLen + 4*6`
            // check exactly (block.Length here is 28 + compressed.Length).
            block = new byte[7 * 4 + compressed.Length];
            BinaryPrimitives.WriteInt32BigEndian(block.AsSpan(16, 4), 1); // hasData
            BinaryPrimitives.WriteInt32BigEndian(block.AsSpan(20, 4), compressed.Length + 4); // subblockLen
            compressed.CopyTo(block, 28);
        }

        // 4(size)+4(beginMarker)+beginName+block+4(endMarker)+endName. Computed from the
        // marker arrays' actual lengths rather than hardcoded — "BlockDataBeginChunk" and
        // "BlockDataEndChunk" are 19/17 chars (38/34 UTF-16BE bytes), easy to miscount by hand.
        int blockSize = 4 + 4 + BlockDataBeginChunk.Length + block.Length + 4 + BlockDataEndChunk.Length;
        Span<byte> header = stackalloc byte[8];
        BinaryPrimitives.WriteInt32BigEndian(header[..4], blockSize);
        BinaryPrimitives.WriteInt32BigEndian(header.Slice(4, 4), 0x10); // begin marker (not validated on read)
        output.Write(header);
        output.Write(BlockDataBeginChunk);
        output.Write(block);

        Span<byte> footerMarker = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(footerMarker, 0x11); // end marker (validated on read)
        output.Write(footerMarker);
        output.Write(BlockDataEndChunk);
    }

    private static byte[] ZlibDeflate(byte[] raw)
    {
        using var output = new MemoryStream();
        using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            zlib.Write(raw, 0, raw.Length);
        }
        return output.ToArray();
    }

    private static byte[] DecodePngToBgra(byte[] pngBytes, int expectedWidth, int expectedHeight)
    {
        using var ms = new MemoryStream(pngBytes);
        var decoder = new PngBitmapDecoder(ms, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        BitmapSource frame = decoder.Frames[0];
        if (frame.Format != PixelFormats.Bgra32)
            frame = new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0);

        var buffer = new byte[expectedWidth * expectedHeight * 4];
        frame.CopyPixels(buffer, expectedWidth * 4, 0);
        return buffer;
    }

    private static void WriteContainer(Stream output, byte[] sqliteBytes, List<(byte[] ChunkId, byte[] Data)> extaChunks)
    {
        output.Write(Encoding.ASCII.GetBytes("CSFCHUNK"));
        output.Write(new byte[16]); // prologue fields the reader never inspects

        WriteChunk(output, "SQLi", sqliteBytes);

        var len8 = new byte[8];
        foreach (var (chunkId, tileData) in extaChunks)
        {
            using var payload = new MemoryStream();
            BinaryPrimitives.WriteInt64BigEndian(len8, chunkId.Length);
            payload.Write(len8);
            payload.Write(chunkId);
            BinaryPrimitives.WriteInt64BigEndian(len8, tileData.Length);
            payload.Write(len8);
            payload.Write(tileData);

            WriteChunk(output, "Exta", payload.ToArray());
        }
    }

    private static void WriteChunk(Stream output, string name, byte[] data)
    {
        output.Write(Encoding.ASCII.GetBytes("CHNK"));
        output.Write(Encoding.ASCII.GetBytes(name));
        output.Write(new byte[4]); // unused by the reader
        Span<byte> size = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(size, (uint)data.Length);
        output.Write(size);
        output.Write(data);
    }

    private sealed class BigEndianWriter
    {
        private readonly MemoryStream _ms = new();

        public void I32(int v)
        {
            Span<byte> b = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(b, v);
            _ms.Write(b);
        }

        public byte[] ToArray() => _ms.ToArray();
    }
}
