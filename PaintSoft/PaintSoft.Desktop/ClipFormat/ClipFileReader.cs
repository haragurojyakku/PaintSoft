using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Data.Sqlite;

namespace PaintSoft.Desktop.ClipFormat;

/// <summary>
/// Reads a CLIP STUDIO PAINT ".clip" file well enough to pull out flattened raster layers.
///
/// This is NOT an official CELSYS format — there is no public specification. Support here is
/// based on community reverse-engineering (Inochi2D/clip-d, dobrokot/clip_to_psd) and is
/// best-effort: vector/text/adjustment layers, layer opacity, blend modes, and folder grouping
/// are not reproduced, and files from future CSP versions may fail to parse.
/// </summary>
public static class ClipFileReader
{
    public static ClipDocument Load(string path)
    {
        byte[] data = File.ReadAllBytes(path);
        var fileChunks = ClipBinary.IterateFileChunks(data);

        byte[]? sqliteBytes = null;
        var chunkMap = new Dictionary<string, List<byte[]?>>();

        foreach (var chunk in fileChunks)
        {
            if (chunk.Name == "SQLi")
            {
                sqliteBytes = data.AsSpan(chunk.Offset, chunk.Size).ToArray();
            }
            else if (chunk.Name == "Exta")
            {
                var span = data.AsSpan(chunk.Offset, chunk.Size);
                if (ClipBinary.TryParseExtaChunk(span, out var chunkId, out var blocks) && blocks is not null)
                {
                    chunkMap[Convert.ToBase64String(chunkId)] = blocks;
                }
            }
        }

        if (sqliteBytes is null)
            throw new InvalidDataException("ファイル内にSQLiteデータ(CHNKSQLi)が見つかりませんでした。");

        string tempDb = Path.Combine(Path.GetTempPath(), $"paintsoft_clip_{Guid.NewGuid():N}.sqlite");
        File.WriteAllBytes(tempDb, sqliteBytes);
        try
        {
            return LoadFromSqlite(tempDb, chunkMap);
        }
        finally
        {
            try { File.Delete(tempDb); } catch { /* best effort cleanup */ }
        }
    }

    private sealed record LayerRow(
        long MainId,
        string Name,
        bool IsFolder,
        long? FirstChildIndex,
        long? NextIndex,
        bool Visible,
        long? RenderMipmap,
        int OffsetX,
        int OffsetY,
        int RenderOffscrOffsetX,
        int RenderOffscrOffsetY);

    private static ClipDocument LoadFromSqlite(string dbPath, Dictionary<string, List<byte[]?>> chunkMap)
    {
        var warnings = new List<string>();
        using var conn = new SqliteConnection($"Data Source={dbPath};Mode=ReadOnly");
        conn.Open();

        var (canvasWidth, canvasHeight, rootFolderId) = ReadCanvas(conn);

        var offscreenById = ReadOffscreen(conn);
        var mipmapBaseInfoById = ReadIdToLongMap(conn, "Mipmap", "MainId", "BaseMipmapInfo");
        var mipmapInfoOffscreenById = ReadIdToLongMap(conn, "MipmapInfo", "MainId", "Offscreen");
        var layerById = ReadLayers(conn);

        var flattened = new List<LayerRow>();
        if (rootFolderId != 0 && layerById.TryGetValue(rootFolderId, out var root))
        {
            FlattenLayerTree(root.FirstChildIndex, layerById, flattened, depth: 0);
        }

        // Traversal order follows the layer linked-list (assumed top-to-bottom in the CSP layer
        // panel, i.e. front-to-back). Reverse to get back-to-front for compositing.
        flattened.Reverse();

        var outLayers = new List<ClipLayer>();
        foreach (var layer in flattened)
        {
            if (layer.RenderMipmap is not long mipmapId) continue;
            if (!mipmapBaseInfoById.TryGetValue(mipmapId, out var mipmapInfoId)) continue;
            if (!mipmapInfoOffscreenById.TryGetValue(mipmapInfoId, out var offscreenId)) continue;
            if (!offscreenById.TryGetValue(offscreenId, out var off)) continue;

            var attr = OffscreenAttribute.TryParse(off.Attribute);
            if (attr is null)
            {
                warnings.Add($"レイヤー「{layer.Name}」: 画像情報を解析できませんでした。");
                continue;
            }

            string key = Convert.ToBase64String(off.BlockData);
            if (!chunkMap.TryGetValue(key, out var tiles))
            {
                warnings.Add($"レイヤー「{layer.Name}」: 画像データチャンクが見つかりませんでした。");
                continue;
            }

            var decoded = ClipLayerRasterizer.Decode(attr, tiles);
            if (decoded is null)
            {
                warnings.Add($"レイヤー「{layer.Name}」: 未対応の形式のため読み込めませんでした（ベクター/マスク/特殊レイヤーの可能性）。");
                continue;
            }

            var (bgra, w, h) = decoded.Value;
            outLayers.Add(new ClipLayer
            {
                Name = layer.Name,
                OffsetX = layer.OffsetX + layer.RenderOffscrOffsetX,
                OffsetY = layer.OffsetY + layer.RenderOffscrOffsetY,
                Width = w,
                Height = h,
                Visible = layer.Visible,
                PngBytes = EncodeBgraToPng(bgra, w, h),
            });
        }

        if (outLayers.Count == 0)
            warnings.Add("読み込めるラスターレイヤーが見つかりませんでした。");

        return new ClipDocument
        {
            Width = canvasWidth,
            Height = canvasHeight,
            Layers = outLayers,
            Warnings = warnings,
        };
    }

    private static void FlattenLayerTree(long? startId, Dictionary<long, LayerRow> layerById, List<LayerRow> outList, int depth)
    {
        if (depth > 64) return; // guard against malformed cyclic data
        long? currentId = startId;
        var visited = new HashSet<long>();

        while (currentId is long id)
        {
            if (!visited.Add(id)) break; // cycle guard
            if (!layerById.TryGetValue(id, out var layer)) break;

            if (layer.IsFolder)
            {
                FlattenLayerTree(layer.FirstChildIndex, layerById, outList, depth + 1);
            }
            else
            {
                outList.Add(layer);
            }

            currentId = layer.NextIndex;
        }
    }

    private static (int Width, int Height, long RootFolderId) ReadCanvas(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT CanvasWidth, CanvasHeight, CanvasRootFolder FROM Canvas LIMIT 1";
        using var reader = cmd.ExecuteReader();
        if (!reader.Read())
            throw new InvalidDataException("Canvas情報を読み取れませんでした。");

        int width = reader.IsDBNull(0) ? 0 : Convert.ToInt32(reader.GetValue(0));
        int height = reader.IsDBNull(1) ? 0 : Convert.ToInt32(reader.GetValue(1));
        long rootFolderId = reader.IsDBNull(2) ? 0 : Convert.ToInt64(reader.GetValue(2));
        return (width, height, rootFolderId);
    }

    private sealed record OffscreenRow(byte[] BlockData, byte[]? Attribute);

    private static Dictionary<long, OffscreenRow> ReadOffscreen(SqliteConnection conn)
    {
        var result = new Dictionary<long, OffscreenRow>();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT MainId, BlockData, Attribute FROM Offscreen";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            long id = reader.GetInt64(0);
            if (reader.IsDBNull(1)) continue;
            byte[] blockData = (byte[])reader.GetValue(1);
            byte[]? attribute = reader.IsDBNull(2) ? null : (byte[])reader.GetValue(2);
            result[id] = new OffscreenRow(blockData, attribute);
        }
        return result;
    }

    private static Dictionary<long, long> ReadIdToLongMap(SqliteConnection conn, string table, string idCol, string valueCol)
    {
        var result = new Dictionary<long, long>();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {idCol}, {valueCol} FROM {table}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (reader.IsDBNull(0) || reader.IsDBNull(1)) continue;
            result[reader.GetInt64(0)] = reader.GetInt64(1);
        }
        return result;
    }

    private static Dictionary<long, LayerRow> ReadLayers(SqliteConnection conn)
    {
        var columns = GetTableColumns(conn, "Layer");
        string Col(string name) => columns.Contains(name) ? name : $"NULL AS {name}";

        using var cmd = conn.CreateCommand();
        cmd.CommandText = $@"SELECT
            MainId,
            {Col("LayerName")},
            {Col("LayerFolder")},
            {Col("LayerFirstChildIndex")},
            {Col("LayerNextIndex")},
            {Col("LayerVisibility")},
            {Col("LayerRenderMipmap")},
            {Col("LayerOffsetX")},
            {Col("LayerOffsetY")},
            {Col("LayerRenderOffscrOffsetX")},
            {Col("LayerRenderOffscrOffsetY")}
            FROM Layer";

        var result = new Dictionary<long, LayerRow>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            long id = reader.GetInt64(0);
            string name = reader.IsDBNull(1) ? $"レイヤー{id}" : reader.GetString(1);
            bool isFolder = !reader.IsDBNull(2) && Convert.ToInt64(reader.GetValue(2)) != 0;
            long? firstChild = reader.IsDBNull(3) ? null : reader.GetInt64(3);
            long? nextIndex = reader.IsDBNull(4) ? null : reader.GetInt64(4);
            bool visible = reader.IsDBNull(5) || Convert.ToInt64(reader.GetValue(5)) != 0;
            long? renderMipmap = reader.IsDBNull(6) ? null : reader.GetInt64(6);
            int offsetX = reader.IsDBNull(7) ? 0 : Convert.ToInt32(reader.GetValue(7));
            int offsetY = reader.IsDBNull(8) ? 0 : Convert.ToInt32(reader.GetValue(8));
            int renderOffX = reader.IsDBNull(9) ? 0 : Convert.ToInt32(reader.GetValue(9));
            int renderOffY = reader.IsDBNull(10) ? 0 : Convert.ToInt32(reader.GetValue(10));

            result[id] = new LayerRow(id, name, isFolder, firstChild, nextIndex, visible, renderMipmap,
                offsetX, offsetY, renderOffX, renderOffY);
        }
        return result;
    }

    private static HashSet<string> GetTableColumns(SqliteConnection conn, string table)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT name FROM pragma_table_info({QuoteLiteral(table)})";
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) set.Add(reader.GetString(0));
        return set;
    }

    private static string QuoteLiteral(string value) => "'" + value.Replace("'", "''") + "'";

    private static byte[] EncodeBgraToPng(byte[] bgra, int width, int height)
    {
        var bitmap = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, bgra, width * 4);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var ms = new MemoryStream();
        encoder.Save(ms);
        return ms.ToArray();
    }
}
