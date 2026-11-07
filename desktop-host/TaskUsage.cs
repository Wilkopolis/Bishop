using System.Text.Json;

namespace Bishop;

/// <summary>Tokens a Claude or Antigravity session used on one task. Cache tokens are counted apart from plain input.</summary>
public record TaskTokens(long Input, long Output, long CacheRead, long CacheCreation, int Messages)
{
    public long Total => Input + Output + CacheRead + CacheCreation;
}

/// <summary>
/// Totals the tokens of a task from the Claude or Antigravity CLI's own transcript for the session. Bishop only reads it.
/// The transcript is JSON lines. Any failure reads as "no data", because a missing number must never stop a task from being ticked.
/// </summary>
public static class TaskUsage
{
    /// <summary>Tokens of the assistant replies between <paramref name="from"/> and <paramref name="to"/>. Null when there is no reading.</summary>
    public static TaskTokens? Read(string cwd, string? claudeSessionId, DateTimeOffset? from, DateTimeOffset to)
    {
        if (string.IsNullOrEmpty(claudeSessionId) || from is null) return null;
        try
        {
            var path = TranscriptPath(cwd, claudeSessionId);
            if (path is null) return null;
            // The CLI may still hold the file open for writing.
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return Sum(ReadLines(reader), from.Value, to);
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't read token usage for session {claudeSessionId}: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// Tokens an Antigravity (Gemini) session used on a task between <paramref name="from"/> and <paramref name="to"/>.
    /// agy writes transcripts under ~/.gemini/antigravity-cli/brain/&lt;conversation-id&gt;/.system_generated/logs/transcript.jsonl.
    /// </summary>
    public static TaskTokens? ReadAntigravity(long projectId, long taskId, DateTimeOffset? from, DateTimeOffset to)
    {
        if (from is null) return null;
        try
        {
            var brain = AntigravityBrainDir();
            if (!Directory.Exists(brain)) return null;
            var candidates = Directory.EnumerateDirectories(brain)
                .Select(d => Path.Combine(d, ".system_generated", "logs", "transcript.jsonl"))
                .Where(f => File.Exists(f) && File.GetLastWriteTimeUtc(f) >= from.Value.UtcDateTime.AddSeconds(-5))
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .ToList();
            if (candidates.Count == 0) return null;

            var briefMarker = $"task-{projectId}-{taskId}-";
            foreach (var path in candidates)
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream);
                var lines = ReadLines(reader).ToList();
                if (!lines.Any(l => l.Contains("\"USER_INPUT\"") && l.Contains(briefMarker, StringComparison.OrdinalIgnoreCase))) continue;
                var tokens = SumAntigravity(lines, from.Value, to);
                if (tokens is not null) return tokens;
            }

            // Fallback when a session didn't carry the standard brief filename in its first message.
            foreach (var path in candidates)
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream);
                var lines = ReadLines(reader).ToList();
                if (!StartsInWindow(lines, from.Value, to)) continue;
                var tokens = SumAntigravity(lines, from.Value, to);
                if (tokens is not null) return tokens;
            }
            return null;
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't read Antigravity token usage for task {taskId}: {ex.Message}");
            return null;
        }
    }

    private static IEnumerable<string> ReadLines(StreamReader reader)
    {
        while (reader.ReadLine() is { } line) yield return line;
    }

    /// <summary>Adds up usage over transcript lines in the window. A reply is written more than once while it streams, so the last copy per message id wins.</summary>
    internal static TaskTokens? Sum(IEnumerable<string> lines, DateTimeOffset from, DateTimeOffset to)
    {
        var byMessage = new Dictionary<string, (long In, long Out, long Read, long Create)>();
        var anonymous = 0;
        foreach (var line in lines)
        {
            if (line.Length == 0 || !line.Contains("\"usage\"")) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var type) || type.GetString() != "assistant") continue;
                if (!root.TryGetProperty("timestamp", out var ts) || !DateTimeOffset.TryParse(ts.GetString(), out var at)) continue;
                if (at < from || at > to) continue;
                if (!root.TryGetProperty("message", out var message) || !message.TryGetProperty("usage", out var usage)) continue;
                var id = message.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                byMessage[id ?? $"#{anonymous++}"] = (Num(usage, "input_tokens"), Num(usage, "output_tokens"),
                    Num(usage, "cache_read_input_tokens"), Num(usage, "cache_creation_input_tokens"));
            }
            catch (JsonException) { } // a half-written last line
        }
        if (byMessage.Count == 0) return null;
        return new TaskTokens(byMessage.Values.Sum(v => v.In), byMessage.Values.Sum(v => v.Out),
            byMessage.Values.Sum(v => v.Read), byMessage.Values.Sum(v => v.Create), byMessage.Count);
    }

    /// <summary>
    /// Adds up usage over Antigravity PLANNER_RESPONSE lines in the window. Timestamps in transcript.jsonl are whole seconds,
    /// so the window allows a small margin on each side. The last copy per step_index wins.
    /// </summary>
    internal static TaskTokens? SumAntigravity(IEnumerable<string> lines, DateTimeOffset from, DateTimeOffset to)
    {
        var start = from.AddSeconds(-1);
        var end = to.AddSeconds(5);
        var byStep = new Dictionary<string, (long In, long Out, long Read, long Create)>();
        var anonymous = 0;
        foreach (var line in lines)
        {
            if (line.Length == 0 || !line.Contains("\"PLANNER_RESPONSE\"")) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var type) || type.GetString() != "PLANNER_RESPONSE") continue;
                if (!root.TryGetProperty("created_at", out var ts) || !DateTimeOffset.TryParse(ts.GetString(), out var at)) continue;
                if (at < start || at > end) continue;
                if (!root.TryGetProperty("input_tokens", out _) && !root.TryGetProperty("output_tokens", out _)) continue;
                var key = root.TryGetProperty("step_index", out var stepEl) && stepEl.ValueKind == JsonValueKind.Number
                    ? stepEl.GetInt64().ToString()
                    : $"#{anonymous++}";
                byStep[key] = (Num(root, "input_tokens"), Num(root, "output_tokens"),
                    Num(root, "cache_read_tokens"), Num(root, "cache_creation_tokens"));
            }
            catch (JsonException) { }
        }
        if (byStep.Count == 0) return null;
        return new TaskTokens(byStep.Values.Sum(v => v.In), byStep.Values.Sum(v => v.Out),
            byStep.Values.Sum(v => v.Read), byStep.Values.Sum(v => v.Create), byStep.Count);
    }

    /// <summary>True when the conversation's initial USER_INPUT step started in the task window and isn't a background PrintAsync prompt.</summary>
    private static bool StartsInWindow(IReadOnlyList<string> lines, DateTimeOffset from, DateTimeOffset to)
    {
        var first = lines.FirstOrDefault();
        if (string.IsNullOrEmpty(first) || first.Contains("Bishop-agy", StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            using var doc = JsonDocument.Parse(first);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "USER_INPUT") return false;
            if (!root.TryGetProperty("created_at", out var ts) || !DateTimeOffset.TryParse(ts.GetString(), out var at)) return false;
            return at >= from.AddSeconds(-2) && at <= to.AddSeconds(2);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string AntigravityBrainDir()
    {
        var appData = Environment.GetEnvironmentVariable("ANTIGRAVITY_APP_DATA_DIR");
        if (string.IsNullOrWhiteSpace(appData))
            appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "antigravity-cli");
        return Path.Combine(appData, "brain");
    }

    private static long Num(JsonElement el, string name) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 0;

    /// <summary>The CLI keeps transcripts in &lt;config dir&gt;\projects\&lt;folder with every non-alphanumeric character as "-"&gt;\&lt;session id&gt;.jsonl.</summary>
    private static string? TranscriptPath(string cwd, string sessionId)
    {
        var configDir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        if (string.IsNullOrWhiteSpace(configDir))
            configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
        var projects = Path.Combine(configDir, "projects");
        var folder = new string(cwd.Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray());
        var direct = Path.Combine(projects, folder, sessionId + ".jsonl");
        if (File.Exists(direct)) return direct;
        // The folder name rule can differ between CLI versions, so fall back to looking for the session id.
        return Directory.Exists(projects)
            ? Directory.EnumerateFiles(projects, sessionId + ".jsonl", SearchOption.AllDirectories).FirstOrDefault()
            : null;
    }
}
