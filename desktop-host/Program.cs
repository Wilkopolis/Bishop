using System.Net;
using System.Reflection;

namespace Bishop;

public class Program
{
    private static BishopWindow? MainWindow;

    private const int DesktopPortStart = 45901;
    private const int DevApiPort = 45900;

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

        Directory.CreateDirectory(AppSettings.AppDataDir);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Info($"Unhandled exception: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) => Log.Info($"Unobserved task exception: {e.Exception}");
        var settings = AppSettings.Load(args);
        var storage = new Storage(settings.DataRoot);
        var backups = new Backups(storage);
        _ = Task.Run(backups.RunDailyIfDue);
        var transcriber = new Transcriber(settings.WhisperModelName, settings.WhisperModelPath);
        var claude = new ClaudeCli(settings.ClaudePath, settings.ClaudeModel);
        Log.Info($"Bishop starting; data={settings.DataRoot}; model={settings.WhisperModelPath}; claude={claude.Resolve() ?? "(not found)"}");

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        int port = apiOnly ? DevApiPort : PickPort(DesktopPortStart);
        builder.WebHost.UseKestrel(options => options.Listen(IPAddress.Loopback, port));

        var app = builder.Build();
        app.MapBishopApi(storage, backups, transcriber, claude, settings, () => MainWindow);

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

        Application.ThreadException += (_, e) => Log.Info($"UI thread exception: {e.Exception}");
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        app.StartAsync().GetAwaiter().GetResult();
        var url = app.Urls.First();

        MainWindow = new BishopWindow(url, AppSettings.AppDataDir);
        Application.Run(MainWindow);

        Log.Info("Bishop exiting");
        app.StopAsync().GetAwaiter().GetResult();
    }
}
