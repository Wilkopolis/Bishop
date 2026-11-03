using System.Net;
using System.Reflection;
using System.Text.Json;

namespace Bishop;

public class Program
{
    private static BishopWindow? MainWindow;

    private const int DesktopPortStart = 45901;
    private const int DevApiPort = 45900;

    private static readonly string AppDataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Bishop"
    );

    /// <summary>
    /// Data root precedence: --data-dir &lt;path&gt;, BISHOP_DATA_DIR, "dataDir" in
    /// %LOCALAPPDATA%\Bishop\settings.json, else %LOCALAPPDATA%\Bishop.
    /// </summary>
    private static string ResolveDataRoot(string[] args)
    {
        var idx = Array.IndexOf(args, "--data-dir");
        if (idx >= 0 && idx + 1 < args.Length) return Path.GetFullPath(args[idx + 1]);

        var env = Environment.GetEnvironmentVariable("BISHOP_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(env)) return Path.GetFullPath(env);

        try
        {
            var settingsPath = Path.Combine(AppDataDir, "settings.json");
            if (File.Exists(settingsPath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));
                if (doc.RootElement.TryGetProperty("dataDir", out var d) && d.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(d.GetString()))
                {
                    return Path.GetFullPath(Environment.ExpandEnvironmentVariables(d.GetString()!));
                }
            }
        }
        catch { }

        return AppDataDir;
    }

    private static int PickPort(int start)
    {
        for (int candidate = start; candidate <= start + 10; candidate++)
        {
            try
            {
                using var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, candidate);
                probe.Start();
                probe.Stop();
                return candidate;
            }
            catch { }
        }
        return 0; // let the OS choose
    }

    private static string GetContentType(string path)
    {
        var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
        return ext switch
        {
            "html" => "text/html; charset=utf-8",
            "js" => "application/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "application/octet-stream"
        };
    }

    [STAThread]
    public static void Main(string[] args)
    {
        // --api-only: run just the HTTP API on the fixed dev port (for `npm run dev`).
        bool apiOnly = args.Contains("--api-only");

        Directory.CreateDirectory(AppDataDir);
        var storage = new Storage(ResolveDataRoot(args));

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        int port = apiOnly ? DevApiPort : PickPort(DesktopPortStart);
        builder.WebHost.UseKestrel(options => options.Listen(IPAddress.Loopback, port));

        var app = builder.Build();
        app.MapBishopApi(storage, () => MainWindow);

        // Serve the embedded Vite build (dist/ -> wwwroot/*) with SPA fallback to index.html.
        var asm = Assembly.GetExecutingAssembly();
        var resources = asm.GetManifestResourceNames()
            .Where(n => n.StartsWith("wwwroot", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(n => n.Replace('\\', '/').Substring("wwwroot/".Length), n => n, StringComparer.OrdinalIgnoreCase);

        app.MapGet("/{**path}", async (string? path, HttpContext ctx) =>
        {
            var reqPath = string.IsNullOrWhiteSpace(path) ? "index.html" : path;
            if (reqPath.StartsWith("api/", StringComparison.OrdinalIgnoreCase))
            {
                ctx.Response.StatusCode = 404;
                return;
            }
            if (!resources.TryGetValue(reqPath, out var resourceName))
            {
                reqPath = "index.html";
                if (!resources.TryGetValue(reqPath, out resourceName))
                {
                    ctx.Response.StatusCode = 404;
                    await ctx.Response.WriteAsync("Bishop UI not built. Run `npm run build` first.");
                    return;
                }
            }
            ctx.Response.ContentType = GetContentType(reqPath);
            if (reqPath.StartsWith("assets/", StringComparison.OrdinalIgnoreCase))
            {
                ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
            }
            using var stream = asm.GetManifestResourceStream(resourceName)!;
            await stream.CopyToAsync(ctx.Response.Body);
        });

        if (apiOnly)
        {
            app.Run();
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        app.StartAsync().GetAwaiter().GetResult();
        var url = app.Urls.First();

        MainWindow = new BishopWindow(url, AppDataDir);
        Application.Run(MainWindow);

        app.StopAsync().GetAwaiter().GetResult();
    }
}
