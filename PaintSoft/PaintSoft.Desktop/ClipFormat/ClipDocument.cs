namespace PaintSoft.Desktop.ClipFormat;

public sealed class ClipLayer
{
    public required string Name { get; init; }
    public required int OffsetX { get; init; }
    public required int OffsetY { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required bool Visible { get; init; }
    public required byte[] PngBytes { get; init; }
}

/// <summary>
/// A flattened (folder structure discarded) view of a .clip document, ordered back-to-front.
/// </summary>
public sealed class ClipDocument
{
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required List<ClipLayer> Layers { get; init; }
    public required List<string> Warnings { get; init; }
}
