using System.Text.Json;

namespace Bishop;

/// <summary>
/// Resolved app configuration. Each value comes from (highest priority first) a
/// command-line flag, an environment variable, %LOCALAPPDATA%\Bishop\settings.json,
/// then a default.
///
///   data root        --data-dir        BISHOP_DATA_DIR        "dataDir"
///   whisper model    --whisper-model   BISHOP_WHISPER_MODEL   "whisperModelPath"  (full path to a ggml .bin)
///   model name       -                 -                      "whisperModel"      (default large-v3-turbo)
///   claude CLI       --claude          BISHOP_CLAUDE_PATH     "claudePath"
///   claude model     -                 -                      "claudeModel"
///   antigravity CLI  --antigravity     BISHOP_ANTIGRAVITY_PATH "antigravityPath"
///   projects root    --projects-root  BISHOP_PROJECTS_ROOT   "projectsRoot"      (default Documents\Bishop; where new project folders are suggested)
/// </summary>
public sealed class AppSettings
{
    public static readonly string AppDataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Bishop"
    );

    public required string DataRoot { get; init; }
    public required string WhisperModelName { get; init; }
    public required string WhisperModelPath { get; init; }
    public string? ClaudePath { get; init; }
    public string? ClaudeModel { get; init; }
    public string? AntigravityPath { get; init; }
    public required string ProjectsRoot { get; init; }

    public static AppSettings Load(string[] args)
    {
        var json = ReadSettingsFile();

        string? Pick(string flag, string env, string key)
        {
            var idx = Array.IndexOf(args, flag);
            if (idx >= 0 && idx + 1 < args.Length) return args[idx + 1];
            var e = Environment.GetEnvironmentVariable(env);
            if (!string.IsNullOrWhiteSpace(e)) return e;
            return json.GetValueOrDefault(key);
        }

        static string FullPath(string p) => Path.GetFullPath(Environment.ExpandEnvironmentVariables(p));

        var dataRoot = Pick("--data-dir", "BISHOP_DATA_DIR", "dataDir") is { } d ? FullPath(d) : AppDataDir;

        var modelName = json.GetValueOrDefault("whisperModel") ?? "large-v3-turbo";
        if (!System.Text.RegularExpressions.Regex.IsMatch(modelName, @"^[a-z0-9.\-]+$"))
            modelName = "large-v3-turbo";
        var modelPath = Pick("--whisper-model", "BISHOP_WHISPER_MODEL", "whisperModelPath") is { } m
            ? FullPath(m)
            : Path.Combine(dataRoot, "models", $"ggml-{modelName}.bin");

        return new AppSettings
        {
            DataRoot = dataRoot,
            WhisperModelName = modelName,
            WhisperModelPath = modelPath,
            ClaudePath = Pick("--claude", "BISHOP_CLAUDE_PATH", "claudePath") is { } c ? FullPath(c) : null,
            ClaudeModel = json.GetValueOrDefault("claudeModel"),
            AntigravityPath = Pick("--antigravity", "BISHOP_ANTIGRAVITY_PATH", "antigravityPath") is { } a ? FullPath(a) : null,
            ProjectsRoot = Pick("--projects-root", "BISHOP_PROJECTS_ROOT", "projectsRoot") is { } pr
                ? FullPath(pr)
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Bishop"),
        };
    }

    private static Dictionary<string, string> ReadSettingsFile()
    {
        var result = new Dictionary<string, string>();
        try
        {
            var path = Path.Combine(AppDataDir, "settings.json");
            if (!File.Exists(path)) return result;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (prop.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(prop.Value.GetString()))
                    result[prop.Name] = prop.Value.GetString()!;
            }
        }
        catch { }
        return result;
    }
}

/// <summary>
/// Rolling log at %LOCALAPPDATA%\Bishop\bishop.log. At 5 MB it rolls to bishop.1.log (then .2, .3);
/// the oldest is dropped. Lines look like: time LEVEL [source] message.
/// </summary>
public static class Log
{
    private const long MaxBytes = 5 * 1024 * 1024;
    private const int Keep = 3;
    private const int MaxMessage = 8000;
    private static readonly object Gate = new();
    private static readonly string LogPath = Path.Combine(AppSettings.AppDataDir, "bishop.log");

    public static void Info(string message, string source = "host") => Write("INFO", source, message);
    public static void Warn(string message, string source = "host") => Write("WARN", source, message);
    public static void Error(string message, Exception? ex = null, string source = "host") =>
        Write("ERROR", source, ex is null ? message : $"{message}: {ex}");

    /// <summary>Writes a line at a level given as text ("debug", "info", "warn", "error"). Used for UI reports.</summary>
    public static void FromText(string? level, string source, string message)
    {
        var l = (level ?? "info").ToLowerInvariant() switch
        {
            "error" => "ERROR",
            "warn" or "warning" => "WARN",
            "debug" => "DEBUG",
            _ => "INFO",
        };
        Write(l, source, message);
    }

    private static void Write(string level, string source, string message)
    {
        if (message.Length > MaxMessage) message = message[..MaxMessage] + "...(truncated)";
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {level,-5} [{source}] {message}";
        Console.WriteLine(line);
        try
        {
            lock (Gate)
            {
                Roll();
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
        }
        catch { }
    }

    private static void Roll()
    {
        var info = new FileInfo(LogPath);
        if (!info.Exists || info.Length < MaxBytes) return;
        string Name(int n) => Path.Combine(AppSettings.AppDataDir, $"bishop.{n}.log");
        if (File.Exists(Name(Keep))) File.Delete(Name(Keep));
        for (var i = Keep - 1; i >= 1; i--)
            if (File.Exists(Name(i))) File.Move(Name(i), Name(i + 1));
        File.Move(LogPath, Name(1));
    }
}

/// <summary>An error with an HTTP status and a machine-readable code for the UI.</summary>
public class ApiProblem(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}
