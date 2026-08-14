using System.Buffers.Binary;
using System.IO;
using System.Text;

namespace PaintSoft.Desktop.ClipFormat;

/// <summary>
/// Low-level binary parsing for the .clip container format (CSFCHUNK/CHNK chunks
/// and the nested BlockData bitmap tile records inside "Exta" chunks).
///
/// The .clip format is not officially documented by CELSYS; this parser follows the
/// clean-room reverse-engineering notes from the community (e.g. Inochi2D/clip-d and
/// dobrokot/clip_to_psd). It is best-effort and may not handle every file variant.
/// </summary>
internal static class ClipBinary
{
    private static readonly byte[] BlockDataBeginChunk = Encoding.BigEndianUnicode.GetBytes("BlockDataBeginChunk");
    private static readonly byte[] BlockDataEndChunk = Encoding.BigEndianUnicode.GetBytes("BlockDataEndChunk");
    private static readonly byte[] BlockStatus = Encoding.BigEndianUnicode.GetBytes("BlockStatus");
    private static readonly byte[] BlockCheckSum = Encoding.BigEndianUnicode.GetBytes("BlockCheckSum");

    public sealed record FileChunk(string Name, int Offset, int Size);

    public static List<FileChunk> IterateFileChunks(byte[] data)
    {
        if (data.Length < 24 || Encoding.ASCII.GetString(data, 0, 8) != "CSFCHUNK")
            throw new InvalidDataException("CLIP STUDIO PAINT形式のファイルとして認識できませんでした（CSFCHUNKヘッダーがありません）。");

        var chunks = new List<FileChunk>();
        int offset = 24;
        while (offset < data.Length)
        {
            if (offset + 16 > data.Length)
                break;

            if (Encoding.ASCII.GetString(data, offset, 4) != "CHNK")
                throw new InvalidDataException($"チャンク境界が不正です（offset={offset}）。");

            string name = Encoding.ASCII.GetString(data, offset + 4, 4);
            uint size = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset + 12, 4));

            int dataOffset = offset + 16;
            if ((long)dataOffset + size > data.Length)
                throw new InvalidDataException($"チャンクサイズがファイル範囲を超えています（chunk={name}）。");

            chunks.Add(new FileChunk(name, dataOffset, (int)size));
            offset = dataOffset + (int)size;
        }

        return chunks;
    }

    /// <summary>
    /// Parses the contents of an "Exta" (external data) chunk: an 8-byte name-length field,
    /// the chunk id string, an 8-byte size, then the payload (either a bitmap block stream or opaque binary).
    /// </summary>
    public static bool TryParseExtaChunk(ReadOnlySpan<byte> chunkData, out byte[] chunkId, out List<byte[]?>? bitmapBlocks)
    {
        chunkId = Array.Empty<byte>();
        bitmapBlocks = null;

        if (chunkData.Length < 16)
            return false;

        long chunkNameLength = BinaryPrimitives.ReadInt64BigEndian(chunkData[..8]);
        if (chunkNameLength <= 0 || chunkNameLength > chunkData.Length - 16)
            return false;

        int cnl = (int)chunkNameLength;
        chunkId = chunkData.Slice(8, cnl).ToArray();

        int binaryStart = 8 + cnl + 8;
        if (binaryStart > chunkData.Length)
            return false;

        var binaryData = chunkData[binaryStart..];
        if (binaryData.Length >= 8 + BlockDataBeginChunk.Length &&
            binaryData.Slice(8, BlockDataBeginChunk.Length).SequenceEqual(BlockDataBeginChunk))
        {
            bitmapBlocks = ParseChunkWithBlocks(binaryData);
        }

        return true;
    }

    /// <summary>
    /// Returns the list of 256x256 compressed sub-blocks (row-major, null = empty tile) for a bitmap Exta chunk.
    /// Returns null if the block stream could not be parsed.
    /// </summary>
    private static List<byte[]?>? ParseChunkWithBlocks(ReadOnlySpan<byte> d)
    {
        var result = new List<byte[]?>();
        int ii = 0;
        int blockCount = 0;

        while (ii < d.Length)
        {
            int blockSize;

            if (StartsWithMarker(d, ii, 0x0b, BlockStatus))
            {
                if (ii + 34 > d.Length) return null;
                int statusCount = BinaryPrimitives.ReadInt32BigEndian(d.Slice(ii + 30, 4));
                blockSize = statusCount * 4 + 12 + (BlockStatus.Length + 4);
            }
            else if (StartsWithMarker(d, ii, 0x0d, BlockCheckSum))
            {
                blockSize = 4 + BlockCheckSum.Length + 12 + blockCount * 4;
            }
            else if (ii + 8 + BlockDataBeginChunk.Length <= d.Length &&
                     d.Slice(ii + 8, BlockDataBeginChunk.Length).SequenceEqual(BlockDataBeginChunk))
            {
                if (ii + 4 > d.Length) return null;
                blockSize = BinaryPrimitives.ReadInt32BigEndian(d.Slice(ii, 4));
                if (blockSize <= 0 || ii + blockSize > d.Length) return null;

                int footerStart = ii + blockSize - (4 + BlockDataEndChunk.Length);
                if (footerStart < 0) return null;
                var footer = d.Slice(footerStart, 4 + BlockDataEndChunk.Length);
                if (BinaryPrimitives.ReadInt32BigEndian(footer[..4]) != 0x11 ||
                    !footer[4..].SequenceEqual(BlockDataEndChunk))
                {
                    return null;
                }

                int blockContentStart = ii + 8 + BlockDataBeginChunk.Length;
                int blockContentEnd = footerStart;
                if (blockContentStart > blockContentEnd) return null;
                var block = d[blockContentStart..blockContentEnd];

                if (block.Length < 5 * 4) return null;
                int hasData = BinaryPrimitives.ReadInt32BigEndian(block.Slice(4 * 4, 4));
                if (hasData is not (0 or 1)) return null;

                if (hasData == 1)
                {
                    if (block.Length < 7 * 4) return null;
                    int subblockLen = BinaryPrimitives.ReadInt32BigEndian(block.Slice(5 * 4, 4));
                    if (block.Length != subblockLen + 4 * 6) return null;
                    result.Add(block[(7 * 4)..].ToArray());
                }
                else
                {
                    result.Add(null);
                }

                blockCount++;
            }
            else
            {
                // Unrecognized record — abort rather than risk misreading the rest of the stream.
                return null;
            }

            ii += blockSize;
        }

        return result;
    }

    private static bool StartsWithMarker(ReadOnlySpan<byte> d, int offset, byte markerByte4, byte[] name)
    {
        int len = 4 + name.Length;
        if (offset + len > d.Length) return false;
        var slice = d.Slice(offset, len);
        return slice[0] == 0 && slice[1] == 0 && slice[2] == 0 && slice[3] == markerByte4 &&
               slice[4..].SequenceEqual(name);
    }
}
