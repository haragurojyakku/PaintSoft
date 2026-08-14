using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using PaintSoft.Desktop.ClipFormat;

namespace PaintSoft.Desktop;

/// <summary>
/// Interaction logic for MainWindow.xaml
/// </summary>
public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await Web.EnsureCoreWebView2Async();

            var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
            Directory.CreateDirectory(webRoot);

            Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                hostName: "paintsoft.local",
                folderPath: webRoot,
                accessKind: CoreWebView2HostResourceAccessKind.Allow);

            Web.CoreWebView2.Navigate("https://paintsoft.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "WebView2 の初期化に失敗しました。\n\n" + ex.Message,
                "PaintSoft",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private async void OnOpenClipClick(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "CLIP STUDIO PAINT ファイルを開く",
            Filter = "CLIP STUDIO PAINT ファイル (*.clip)|*.clip|すべてのファイル (*.*)|*.*",
        };

        if (dialog.ShowDialog(this) != true)
            return;

        OpenClipButton.IsEnabled = false;
        Mouse.OverrideCursor = Cursors.Wait;
        try
        {
            var doc = await Task.Run(() => ClipFileReader.Load(dialog.FileName));

            if (doc.Layers.Count == 0)
            {
                MessageBox.Show(
                    this,
                    "読み込めるラスターレイヤーが見つかりませんでした。\n\n" +
                    ".clip形式は非公開のため、対応は簡易ラスターレイヤーのみです。\n" +
                    string.Join("\n", doc.Warnings),
                    "PaintSoft",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }

            var dto = new ClipDocumentDto(
                doc.Width,
                doc.Height,
                doc.Layers.Select(l => new ClipLayerDto(
                    l.Name, l.OffsetX, l.OffsetY, l.Width, l.Height, l.Visible,
                    "data:image/png;base64," + Convert.ToBase64String(l.PngBytes))).ToList());

            string json = JsonSerializer.Serialize(dto, ClipDtoJsonContext.Default.ClipDocumentDto);

            await Web.CoreWebView2.ExecuteScriptAsync($"window.loadClipDocument({json})");

            if (doc.Warnings.Count > 0)
            {
                MessageBox.Show(
                    this,
                    $"{doc.Layers.Count} 個のレイヤーを読み込みました。\n\n一部読み込めなかった項目があります:\n" +
                    string.Join("\n", doc.Warnings),
                    "PaintSoft",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "clipファイルの読み込みに失敗しました。\n\n" + ex.Message,
                "PaintSoft",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        finally
        {
            Mouse.OverrideCursor = null;
            OpenClipButton.IsEnabled = true;
            // ShowDialog() leaves WPF keyboard focus on this button (not the WebView2
            // content), so keyboard shortcuts in the web page stop reaching it until the
            // user clicks back in. Restore focus explicitly instead.
            Web.Focus();
        }
    }

    private async void OnSaveClipClick(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "CLIP STUDIO PAINT 形式で保存",
            Filter = "CLIP STUDIO PAINT ファイル (*.clip)|*.clip|すべてのファイル (*.*)|*.*",
            FileName = "paintsoft.clip",
        };

        if (dialog.ShowDialog(this) != true)
            return;

        SaveClipButton.IsEnabled = false;
        Mouse.OverrideCursor = Cursors.Wait;
        try
        {
            string json = await Web.CoreWebView2.ExecuteScriptAsync("window.getClipExportDocument()");
            var dto = JsonSerializer.Deserialize(json, ClipDtoJsonContext.Default.ClipDocumentDto)
                ?? throw new InvalidDataException("キャンバスの情報を取得できませんでした。");

            var doc = new ClipDocument
            {
                Width = dto.width,
                Height = dto.height,
                Layers = dto.layers.Select(l => new ClipLayer
                {
                    Name = l.name,
                    OffsetX = l.x,
                    OffsetY = l.y,
                    Width = l.width,
                    Height = l.height,
                    Visible = l.visible,
                    PngBytes = Convert.FromBase64String(StripDataUrlPrefix(l.png)),
                }).ToList(),
                Warnings = new List<string>(),
            };

            await Task.Run(() => ClipFileWriter.Save(dialog.FileName, doc));

            MessageBox.Show(
                this,
                $"{doc.Layers.Count} 個のレイヤーを .clip として保存しました。\n\n" +
                "注意: これは非公式の簡易再現フォーマットです。本アプリでの再読み込みはできますが、\n" +
                "CLIP STUDIO PAINT で開けることは保証されません（.clipは非公開フォーマットのため）。",
                "PaintSoft",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "clipファイルの保存に失敗しました。\n\n" + ex.Message,
                "PaintSoft",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        finally
        {
            Mouse.OverrideCursor = null;
            SaveClipButton.IsEnabled = true;
            // Same focus-restoration reason as OnOpenClipClick above.
            Web.Focus();
        }
    }

    private static string StripDataUrlPrefix(string dataUrl)
    {
        int comma = dataUrl.IndexOf(',');
        return comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
    }
}

internal sealed record ClipLayerDto(
    string name, int x, int y, int width, int height, bool visible, string png);

internal sealed record ClipDocumentDto(int width, int height, System.Collections.Generic.List<ClipLayerDto> layers);

[JsonSerializable(typeof(ClipDocumentDto))]
internal partial class ClipDtoJsonContext : JsonSerializerContext
{
}