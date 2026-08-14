using System.Buffers.Binary;
using System.IO;

namespace PaintSoft.Desktop.ClipFormat;

/// <summary>
/// Decoded form of an Offscreen.Attribute blob: bitmap dimensions, the 256px block grid
/// size, and the channel packing layout used by the compressed tile data.
/// </summary>
internal sealed record OffscreenAttribute(
    int BitmapWidth,
    int BitmapHeight,
    int BlockGridWidth,
    int BlockGridHeight,
    bool DefaultFillWhite,
    int FirstChannelCount,
    int SecondChannelCount)
{
    public bool IsColorLayer => FirstChannelCount == 1 && SecondChannelCount == 4;

    public static OffscreenAttribute? TryParse(byte[]? attribute)
    {
        if (attribute is null || attribute.Length < 16)
            return null;

        try
        {
            var r = new BigEndianCursor(attribute);

            int headerSize = r.ReadInt32();
            if (headerSize != 16) return null;
            r.ReadInt32(); // info_section_size
            int extraInfoSectionSize = r.ReadInt32();
            r.ReadInt32(); // unknown

            r.SkipCspUnicodeString(); // "Parameter"

            int width = r.ReadInt32();
            int height = r.ReadInt32();
            int gridWidth = r.ReadInt32();
            int gridHeight = r.ReadInt32();

            var attrs = new int[16];
            for (int i = 0; i < 16; i++) attrs[i] = r.ReadInt32();

            r.SkipCspUnicodeString(); // "InitColor"
            r.ReadInt32();
            int defaultFillBlackWhite = r.ReadInt32();

            if (width <= 0 || height <= 0 || gridWidth <= 0 || gridHeight <= 0)
                return null;

            return new OffscreenAttribute(
                width, height, gridWidth, gridHeight,
                DefaultFillWhite: defaultFillBlackWhite != 0,
                FirstChannelCount: attrs[1],
                SecondChannelCount: attrs[2]);
        }
        catch (Exception)
        {
            // Malformed / unrecognized attribute layout — treat as "can't decode this layer".
            return null;
        }
    }

    private ref struct BigEndianCursor
    {
        private readonly byte[] _data;
        private int _pos;

        public BigEndianCursor(byte[] data)
        {
            _data = data;
            _pos = 0;
        }

        public int ReadInt32()
        {
            if (_pos + 4 > _data.Length) throw new EndOfStreamException();
            int v = BinaryPrimitives.ReadInt32BigEndian(_data.AsSpan(_pos, 4));
            _pos += 4;
            return v;
        }

        public void SkipCspUnicodeString()
        {
            int charCount = ReadInt32();
            if (charCount < 0) throw new InvalidDataException();
            int byteLen = charCount * 2;
            if (_pos + byteLen > _data.Length) throw new EndOfStreamException();
            _pos += byteLen;
        }
    }
}
