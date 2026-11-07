using System.Net;
using System.Reflection;

namespace Bishop;

public class Program
{
    private static BishopWindow? MainWindow;

    private const int DesktopPortStart = 45901;
    private const int DevApiPort = 45900;

    /// <summary>
    /// If Bishop was started from inside a Claude Code session, it inherits that session's markers
    /// (session ids, messaging socket/token, child-session flags). Passed on, they make the terminal's
    /// claude behave like a sub-session. Remove them; user configuration variables are left alone.
    /// </summary>
    private static void ScrubInheritedClaudeSession()
    {
        var env = Environment.GetEnvironmentVariables();
        if (!env.Contains("CLAUDECODE") && !env.Contains("CLAUDE_CODE_SESSION_ID")) return;
        string[] prefixes =
        [
            "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PREVIEW_", "CLAUDE_AGENT_SDK_",
            "CLAUDE_CODE_SESSION", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_HOST_SESSION", "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_MESSAGING_", "CLAUDE_CODE_SDK_", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_DESKTOP_APP_",
            "CLAUDE_CODE_OAUTH_", "CLAUDE_CODE_ACCOUNT_", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_ORGANIZATION_",
            "CLAUDE_CODE_EMIT_", "CLAUDE_CODE_ENABLE_", "CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
            "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_EAGER_FLUSH", "CLAUDE_CODE_STARTUP_", "CLAUDE_CODE_TERMINAL_MCP_",
        ];
        var removed = 0;
        foreach (var key in env.Keys.Cast<string>().ToList())
        {
            if (prefixes.Any(p => key.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            {
                Environment.SetEnvironmentVariable(key, null);
                removed++;
            }
        }
        Log.Info($"Started from inside a Claude Code session; cleared {removed} inherited session variables");
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

        Directory.CreateDirectory(AppSettings.AppDataDir);
        ScrubInheritedClaudeSession();
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Info($"Unhandled exception: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) => Log.Info($"Unobserved task exception: {e.Exception}");
        var settings = AppSettings.Load(args);
        var storage = new Storage(settings.DataRoot);
        var backups = new Backups(storage);
        _ = Task.Run(backups.RunDailyIfDue);
        var transcriber = new Transcriber(settings.WhisperModelName, settings.WhisperModelPath);
        var antigravity = new AntigravityCli(settings.AntigravityPath);
        var claude = new ClaudeCli(settings.ClaudePath, settings.ClaudeModel, antigravity);
        using var terminals = new Terminals(claude, antigravity, settings.DataRoot);
        Log.Info($"Bishop starting; data={settings.DataRoot}; model={settings.WhisperModelPath}; claude={claude.Resolve() ?? "(not found)"}");

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        int port = apiOnly ? DevApiPort : PickPort(DesktopPortStart);
        builder.WebHost.UseKestrel(options => options.Listen(IPAddress.Loopback, port));

        // Runs in the API-only dev mode too, so the numbers are saved whichever way Bishop starts.
        terminals.TaskCompleted += c =>
        {
            long? topicId = null;
            try { topicId = storage.GetTask(c.ProjectId, c.TaskId).TopicId; } catch (Exception) { }
            storage.RecordTaskMetrics(c, topicId, c.Kind.ToString().ToLowerInvariant());
        };

        // Saves sessions so the sessions panel can list the past week after a restart.
        terminals.SessionChanged += (info, startedAt) => storage.SaveSession(info, startedAt);

        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
        app.MapBishopApi(storage, backups, transcriber, claude, settings, terminals, () => MainWindow);

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
        terminals.TaskCompleted += _ => MainWindow.FlashTaskbarIfIdle();
        Application.Run(MainWindow);

        Log.Info("Bishop exiting");
        app.StopAsync().GetAwaiter().GetResult();
    }
}
