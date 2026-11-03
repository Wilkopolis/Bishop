using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Bishop;

public record TopicDraft(string Title, string Description, string Category, List<string> Tasks);

/// <summary>
/// Runs the Claude Code CLI in print mode to turn a voice transcript into a
/// proposed topic. The transcript goes over stdin, never argv.
/// </summary>
public sealed class ClaudeCli(string? configuredPath, string? model)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(120);

    private const string Instructions = """
        You turn a spoken note about a software or personal project into ONE topic for a project management app.
        The input on stdin has the project name and the raw voice transcript, which may ramble or contain filler words.

        Respond with ONLY a JSON object. No markdown, no code fences, no commentary. Exact shape:
        {"title": string, "description": string, "category": "RIGHT_NOW" | "SOON" | "LATER" | "BACKLOG", "tasks": string[]}

        Rules:
        - title: short and specific, at most 80 characters.
        - description: 1-3 plain sentences summarizing what the note is about.
        - category: from the urgency in the note. RIGHT_NOW = urgent or being worked on now; SOON = next up;
          LATER = planned but not soon; BACKLOG = someday, ideas, or unclear timing.
        - tasks: 0-12 short imperative action items that the note states or clearly implies. Don't invent extra work.
        - Write in the same language as the transcript.
        """;

    /// <summary>Finds the CLI: configured path, PATH, ~/.local/bin, then the desktop app's bundled copy.</summary>
    public string? Resolve()
    {
        if (!string.IsNullOrEmpty(configuredPath))
            return File.Exists(configuredPath) ? configuredPath : null;

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in new[] { "claude.exe", "claude.cmd" })
            {
                try
                {
                    var p = Path.Combine(dir.Trim(), name);
                    if (File.Exists(p)) return p;
                }
                catch { }
            }
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var local = Path.Combine(home, ".local", "bin", "claude.exe");
        if (File.Exists(local)) return local;

        // Claude desktop bundles the CLI under Claude-Data\<profile>\claude-code\<version>\<hash>\claude.exe.
        try
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var bundled = Directory.EnumerateDirectories(Path.Combine(appData, "Claude-Data"))
                .Select(d => Path.Combine(d, "claude-code"))
                .Where(Directory.Exists)
                .SelectMany(Directory.EnumerateDirectories)
                .OrderByDescending(d => Version.TryParse(Path.GetFileName(d), out var v) ? v : new Version(0, 0))
                .SelectMany(d => Directory.EnumerateFiles(d, "claude.exe", SearchOption.AllDirectories))
                .FirstOrDefault();
            if (bundled is not null) return bundled;
        }
        catch { }

        return null;
    }

    public async Task<TopicDraft> TopicFromTranscriptAsync(string projectName, string transcript, CancellationToken ct)
    {
        var exe = Resolve() ?? throw new ApiProblem(503, "claude_missing",
            "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, or set \"claudePath\" in settings.json.");

        var workDir = Path.Combine(Path.GetTempPath(), "Bishop-claude");
        Directory.CreateDirectory(workDir);

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = workDir, // keep it away from any repo CLAUDE.md
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(exe);
        }
        // Instructions go in a file: a .cmd shim runs through cmd.exe, which would mangle
        // multi-line text with quotes and pipes on the command line.
        var promptFile = Path.Combine(workDir, "topic-from-transcript.txt");
        await File.WriteAllTextAsync(promptFile, Instructions, ct);
        foreach (var arg in new[]
                 {
                     "-p", "Create the topic JSON for the note on stdin.",
                     "--system-prompt-file", promptFile,
                     "--output-format", "json",
                     "--tools", "",
                     "--strict-mcp-config",
                     "--no-session-persistence",
                 })
            psi.ArgumentList.Add(arg);
        if (!string.IsNullOrEmpty(model))
        {
            psi.ArgumentList.Add("--model");
            psi.ArgumentList.Add(model);
        }

        var sw = Stopwatch.StartNew();
        using var proc = Process.Start(psi) ?? throw new ApiProblem(500, "claude_failed", "Couldn't start the Claude CLI.");
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
        await proc.StandardInput.WriteAsync($"Project: {projectName}\n\nTranscript:\n{transcript}\n");
        proc.StandardInput.Close();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        try
        {
            await proc.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            if (ct.IsCancellationRequested) throw;
            throw new ApiProblem(504, "claude_timeout", $"Claude CLI didn't answer within {Timeout.TotalSeconds:F0} seconds.");
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        Log.Info($"claude -p finished in {sw.ElapsedMilliseconds}ms, exit {proc.ExitCode}");
        return ParseResult(stdout, stderr, proc.ExitCode);
    }

    internal static TopicDraft ParseResult(string stdout, string stderr, int exitCode)
    {
        JsonElement envelope;
        try
        {
            envelope = JsonDocument.Parse(stdout).RootElement;
        }
        catch (JsonException)
        {
            var detail = FirstLine(stderr) ?? FirstLine(stdout) ?? $"exit code {exitCode}";
            throw new ApiProblem(502, "claude_failed", $"Claude CLI failed: {detail}");
        }

        var result = envelope.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() ?? "" : "";
        if (envelope.TryGetProperty("is_error", out var isErr) && isErr.ValueKind == JsonValueKind.True)
        {
            if (result.Contains("Not logged in", StringComparison.OrdinalIgnoreCase) || result.Contains("/login"))
                throw new ApiProblem(401, "claude_not_logged_in", "Claude CLI is not signed in. Run `claude` in a terminal once and sign in.");
            throw new ApiProblem(502, "claude_failed", $"Claude CLI error: {FirstLine(result) ?? "unknown error"}");
        }

        return ParseDraft(result);
    }

    /// <summary>Strictly parse the model's answer into a draft; tolerate code fences and surrounding text.</summary>
    internal static TopicDraft ParseDraft(string text)
    {
        var cleaned = Regex.Replace(text.Trim(), @"^```[a-zA-Z]*\s*|\s*```$", "");
        var start = cleaned.IndexOf('{');
        var end = cleaned.LastIndexOf('}');
        if (start < 0 || end <= start)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer didn't contain a JSON topic.");

        JsonElement obj;
        try
        {
            obj = JsonDocument.Parse(cleaned[start..(end + 1)]).RootElement;
        }
        catch (JsonException ex)
        {
            throw new ApiProblem(502, "claude_bad_output", $"Claude's answer wasn't valid JSON: {ex.Message}");
        }
        if (obj.ValueKind != JsonValueKind.Object)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer wasn't a JSON object.");

        string Str(string name) =>
            obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : "";

        var title = Str("title");
        if (title.Length == 0)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer had no title.");
        if (title.Length > 120) title = title[..120].TrimEnd();

        var category = Str("category").ToUpperInvariant().Replace(' ', '_').Replace('-', '_');
        if (!Storage.Categories.Contains(category)) category = "BACKLOG";

        var tasks = new List<string>();
        if (obj.TryGetProperty("tasks", out var t) && t.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in t.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && item.GetString()!.Trim() is { Length: > 0 } s)
                    tasks.Add(s);
            }
        }

        return new TopicDraft(title, Str("description"), category, tasks.Take(20).ToList());
    }

    private static string? FirstLine(string s) =>
        s.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
}
