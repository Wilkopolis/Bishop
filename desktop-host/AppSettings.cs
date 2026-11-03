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

/// <summary>Simple append-only log at %LOCALAPPDATA%\Bishop\bishop.log.</summary>
public static class Log
{
    private static readonly object Gate = new();
    private static readonly string LogPath = Path.Combine(AppSettings.AppDataDir, "bishop.log");

    public static void Info(string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}";
        Console.WriteLine(line);
        try
        {
            lock (Gate) File.AppendAllText(LogPath, line + Environment.NewLine);
        }
        catch { }
    }
}

/// <summary>An error with an HTTP status and a machine-readable code for the UI.</summary>
public class ApiProblem(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}
