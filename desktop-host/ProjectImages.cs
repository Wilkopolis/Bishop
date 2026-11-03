using System.Drawing;
using System.Runtime.InteropServices;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace Bishop;

/// <summary>
/// Validates and normalizes uploaded project pictures. The UI already downscales
/// before uploading; this is the server-side guard for size, type and dimensions.
/// </summary>
public static class ProjectImages
{
    public const long MaxUploadBytes = 20L * 1024 * 1024;
    public const int MaxDimension = 1600;

    /// <summary>Detects the type from the file's bytes (never trusts the client's Content-Type).</summary>
    public static string? SniffMime(ReadOnlySpan<byte> d)
    {
        if (d.Length >= 8 && d[0] == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') return "image/png";
        if (d.Length >= 3 && d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF) return "image/jpeg";
        if (d.Length >= 6 && d[0] == 'G' && d[1] == 'I' && d[2] == 'F' && d[3] == '8') return "image/gif";
        if (d.Length >= 12 && d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F' && d[8] == 'W' && d[9] == 'E' && d[10] == 'B' && d[11] == 'P')
            return "image/webp";
        return null;
    }

    public static ProjectImage Prepare(byte[] data)
    {
        if (data.Length == 0) throw new ArgumentException("No image received");
        if (data.Length > MaxUploadBytes)
            throw new ArgumentException($"Picture is too large ({data.Length / 1048576.0:F1} MB); the limit is {MaxUploadBytes / 1048576} MB");
        var mime = SniffMime(data) ?? throw new ArgumentException("Unsupported picture type. Use PNG, JPEG, WebP or GIF.");

        // GIF stays as-is to keep animation; WebP can't be decoded by GDI+ (the UI re-encodes those).
        if (mime is "image/png" or "image/jpeg")
        {
            try
            {
                return Downscale(data, mime);
            }
            catch (Exception ex) when (ex is ArgumentException or ExternalException or OutOfMemoryException)
            {
                throw new ArgumentException("That picture couldn't be read. It may be damaged.");
            }
        }
        return new ProjectImage(mime, data);
    }

    private static ProjectImage Downscale(byte[] data, string mime)
    {
        using var input = new MemoryStream(data);
        using var src = Image.FromStream(input);
        var longest = Math.Max(src.Width, src.Height);
        if (longest <= MaxDimension) return new ProjectImage(mime, data);

        var scale = (double)MaxDimension / longest;
        int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
        using var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(dst))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.DrawImage(src, 0, 0, w, h);
        }

        using var output = new MemoryStream();
        if (mime == "image/png")
        {
            dst.Save(output, ImageFormat.Png); // keeps transparency
        }
        else
        {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
            using var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
            dst.Save(output, codec, p);
        }
        return new ProjectImage(mime, output.ToArray());
    }
}
