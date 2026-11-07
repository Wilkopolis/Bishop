using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Bishop;

/// <summary>
/// Antigravity plan usage, one model group per reading, because agy has a limit per group and no overall one. Installed
/// is false when agy isn't found. A window is null when there is no reading. Argon is null on plans without a separate
/// Argon quota. The Flash windows are the limits of the group Gemini Flash belongs to.
/// </summary>
public record AntigravityUsage(bool Installed, UsageWindow? Argon, UsageWindow? FlashSession, UsageWindow? FlashWeek, UsageWindow? ClaudeGptSession, UsageWindow? ClaudeGptWeek);

/// <summary>Finds the Google Antigravity CLI (agy), which the Terminal can run instead of Claude.</summary>
public sealed class AntigravityCli(string? configuredPath)
{
    private static readonly TimeSpan ModelsTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan ModelsMaxAge = TimeSpan.FromHours(1);
    private static readonly TimeSpan UsageTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan UsageMaxAge = TimeSpan.FromSeconds(60);
    private static readonly Regex LevelInLabel = new(@"^(.+) \(([^()]+)\)$");

    private readonly SemaphoreSlim _usageGate = new(1, 1);
    private List<TerminalModel> _models = [];
    private DateTime _modelsAt = DateTime.MinValue;
    private AntigravityUsage _usage = new(false, null, null, null, null, null);
    private DateTime _usageAt = DateTime.MinValue;
    private bool _usageUnsupported;

    /// <summary>Finds the CLI: configured path, PATH, then the installer's folder.</summary>
    public string? Resolve()
    {
        if (!string.IsNullOrEmpty(configuredPath))
            return File.Exists(configuredPath) ? configuredPath : null;

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var p = Path.Combine(dir.Trim(), "agy.exe");
                if (File.Exists(p)) return p;
            }
            catch { }
        }

        // Bishop may have started before the installer added this folder to PATH.
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var installed = Path.Combine(appData, "agy", "bin", "agy.exe");
        return File.Exists(installed) ? installed : null;
    }

    /// <summary>agy's own settings file. Its trust dialog saves the folders it was told to trust here.</summary>
    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "antigravity-cli", "settings.json");

    private static string PlainPath(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    private static bool HasFolder(JsonArray? folders, string folder) =>
        folders?.Any(f => f?.GetValueKind() == JsonValueKind.String
            && string.Equals(PlainPath(f.GetValue<string>()), PlainPath(folder), StringComparison.OrdinalIgnoreCase)) == true;

    /// <summary>
    /// False means agy will open its trust dialog in this folder. A task would then run behind the dialog, out of sight.
    /// An unreadable settings file reads as false: at worst the user is asked once more.
    /// </summary>
    public bool IsTrusted(string folder)
    {
        try
        {
            return File.Exists(SettingsPath) && HasFolder(JsonNode.Parse(File.ReadAllText(SettingsPath))?["trustedWorkspaces"] as JsonArray, folder);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            Log.Info($"Couldn't read agy's settings: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Saves what answering yes in agy's trust dialog saves. Only call this after the user agreed. Other settings stay as they
    /// are, and a file Bishop can't read is left alone.
    /// </summary>
    public void Trust(string folder)
    {
        try
        {
            var settings = File.Exists(SettingsPath) ? JsonNode.Parse(File.ReadAllText(SettingsPath)) as JsonObject ?? throw new JsonException("Not a JSON object") : [];
            if (settings["trustedWorkspaces"] is not JsonArray folders)
            {
                if (settings["trustedWorkspaces"] is not null) throw new JsonException("trustedWorkspaces isn't a list");
                settings["trustedWorkspaces"] = folders = [];
            }
            if (HasFolder(folders, folder)) return;
            folders.Add(PlainPath(folder));

            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var temp = SettingsPath + ".bishop.tmp";
            File.WriteAllText(temp, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
            File.Move(temp, SettingsPath, overwrite: true);
            Log.Info($"Antigravity now trusts {folder}");
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            Log.Info($"Couldn't save agy's trust for {folder}: {ex.Message}");
            throw new ApiProblem(500, "antigravity_trust_failed", "Bishop couldn't save this in Antigravity's settings. Start Antigravity in the Terminal and answer its trust question there.");
        }
    }

    /// <summary>The models `agy models` lists. Any failure reads as an empty list, and the next call tries again.</summary>
    public async Task<List<TerminalModel>> ModelsAsync(CancellationToken ct)
    {
        if (_models.Count > 0 && DateTime.UtcNow - _modelsAt < ModelsMaxAge) return _models;
        if (await OutputOfAsync(["models"], ModelsTimeout, ct) is not { } stdout) return [];
        var models = ParseModels(stdout);
        if (models.Count > 0)
        {
            _models = models;
            _modelsAt = DateTime.UtcNow;
        }
        return models;
    }

    /// <summary>
    /// Reads usage from `agy -p /usage`. It runs locally, so it spends no quota, and Bishop never touches the
    /// CLI's credentials. Any failure reads as "no data".
    /// </summary>
    public async Task<AntigravityUsage> UsageAsync(CancellationToken ct)
    {
        await _usageGate.WaitAsync(ct);
        try
        {
            if (_usageUnsupported || DateTime.UtcNow - _usageAt < UsageMaxAge) return _usage;
            _usage = await ReadUsageAsync(ct);
            _usageAt = DateTime.UtcNow;
            return _usage;
        }
        finally
        {
            _usageGate.Release();
        }
    }

    private async Task<AntigravityUsage> ReadUsageAsync(CancellationToken ct)
    {
        if (Resolve() is null) return new(false, null, null, null, null, null);
        var none = new AntigravityUsage(true, null, null, null, null, null);
        if (await OutputOfAsync(["-p", "/usage", "--output-format", "json"], UsageTimeout, ct) is not { } stdout) return none;
        try
        {
            var envelope = JsonDocument.Parse(stdout).RootElement;
            // A conversation means "/usage" went to the model as a prompt. Don't keep spending quota on that.
            if (envelope.TryGetProperty("conversation_id", out var id) && !string.IsNullOrEmpty(id.GetString()))
            {
                _usageUnsupported = true;
                Log.Info("agy -p /usage isn't a local command in this CLI; the usage meter stays empty");
                return none;
            }
            return new(true, ArgonWeek(envelope), FlashWindow(envelope, "5h"), FlashWindow(envelope, "weekly"), ClaudeGptWindow(envelope, "5h"), ClaudeGptWindow(envelope, "weekly"));
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            Log.Info($"agy -p /usage failed: {ex.Message}");
            return none;
        }
    }

    /// <summary>A window ("5h" or "weekly") of the first group that matches. Its group goes in the reset text, so the meter's tooltip can name it.</summary>
    private static UsageWindow? GroupWindow(JsonElement envelope, string window, Func<JsonElement, bool> isGroup)
    {
        if (!envelope.TryGetProperty("command", out var command) || !command.TryGetProperty("data", out var data)
            || !data.TryGetProperty("groups", out var groups) || groups.ValueKind != JsonValueKind.Array) return null;

        foreach (var group in groups.EnumerateArray())
        {
            if (!group.TryGetProperty("buckets", out var buckets) || buckets.ValueKind != JsonValueKind.Array) continue;
            if (!isGroup(group)) continue;
            foreach (var bucket in buckets.EnumerateArray())
            {
                if (!bucket.TryGetProperty("window", out var w) || w.GetString() != window) continue;
                if (!bucket.TryGetProperty("remaining_fraction", out var left) || left.ValueKind != JsonValueKind.Number) continue;
                var percent = (1 - left.GetDouble()) * 100;
                // An unused limit has nothing to reset: agy just reports now plus the window.
                var resets = percent > 0 && bucket.TryGetProperty("reset_time", out var r) ? ResetText(r.GetString(), group) : null;
                return new UsageWindow(percent, resets);
            }
        }
        return null;
    }

    /// <summary>The weekly limit of the Argon group, which has its own quota on paid Pro plans. Ultra plans have no such group.</summary>
    internal static UsageWindow? ArgonWeek(JsonElement envelope) =>
        GroupWindow(envelope, "weekly", group => group.TryGetProperty("name", out var name)
            && name.GetString()?.Contains("Argon", StringComparison.OrdinalIgnoreCase) == true);

    /// <summary>
    /// A limit of the group Gemini Flash belongs to. agy has no group for Flash alone: it shares "Gemini Models" with
    /// Gemini Pro, and only the group's description names it ("Models within this group: Gemini Flash, Gemini Pro").
    /// </summary>
    internal static UsageWindow? FlashWindow(JsonElement envelope, string window) =>
        GroupWindow(envelope, window, group => Lists(group, "Gemini Flash"));

    /// <summary>A limit of the group that holds the Claude and GPT models agy offers ("Claude and GPT models").</summary>
    internal static UsageWindow? ClaudeGptWindow(JsonElement envelope, string window) =>
        GroupWindow(envelope, window, group => Lists(group, "Claude"));

    private static bool Lists(JsonElement group, string model) =>
        group.TryGetProperty("description", out var description)
        && description.GetString()?.Contains(model, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>"2026-11-05T16:36:43Z" gives "Nov 5, 11:36am (Gemini Models)", in local time like Claude's reset text.</summary>
    private static string? ResetText(string? time, JsonElement group)
    {
        if (!DateTimeOffset.TryParse(time, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)) return null;
        var local = parsed.ToLocalTime();
        var text = local.ToString("MMM d, h:mm", CultureInfo.InvariantCulture) + local.ToString("tt", CultureInfo.InvariantCulture).ToLowerInvariant();
        return group.TryGetProperty("name", out var name) && name.GetString() is { Length: > 0 } n ? $"{text} ({n})" : text;
    }

    /// <summary>
    /// Runs one print-mode prompt in agy's read-only plan mode and returns its answer text. agy doesn't read stdin in
    /// print mode, so the text goes in a temp file that the prompt points to, never on the command line. The model's
    /// id and level are the ones <see cref="ModelsAsync"/> lists. agy runs in the project folder only when it already
    /// trusts it, because an untrusted folder would open a trust dialog that nobody sees. Otherwise it runs in temp.
    /// </summary>
    public async Task<string> PrintAsync(string text, string? projectFolder, string model, string? effort, TimeSpan limit, CancellationToken ct)
    {
        var exe = Resolve() ?? throw new ApiProblem(503, "antigravity_missing", "Antigravity CLI (agy) not found. Install it, or set \"antigravityPath\" in settings.json.");

        var tempDir = Path.Combine(Path.GetTempPath(), "Bishop-agy");
        Directory.CreateDirectory(tempDir);
        var workDir = projectFolder is not null && IsTrusted(projectFolder) ? projectFolder : tempDir;
        var file = Path.Combine(tempDir, $"prompt-{Guid.NewGuid():N}.txt");
        await File.WriteAllTextAsync(file, text, new UTF8Encoding(false), ct);

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = workDir,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in new[]
                 {
                     "-p", $"Read the file {file} and follow the instructions in it. Answer with only what it asks for.",
                     "--output-format", "json",
                     "--mode", "plan",
                     "--add-dir", tempDir,
                     "--model", model,
                 })
            psi.ArgumentList.Add(arg);
        if (effort is not null)
        {
            psi.ArgumentList.Add("--effort");
            psi.ArgumentList.Add(effort);
        }

        Process? proc = null;
        try
        {
            var sw = Stopwatch.StartNew();
            proc = Process.Start(psi) ?? throw new ApiProblem(500, "antigravity_failed", "Couldn't start the Antigravity CLI.");
            var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = proc.StandardError.ReadToEndAsync(ct);
            proc.StandardInput.Close();

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(limit);
            try
            {
                await proc.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                if (ct.IsCancellationRequested) throw;
                throw new ApiProblem(504, "antigravity_timeout", $"Antigravity CLI didn't answer within {limit.TotalSeconds:F0} seconds.");
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            Log.Info($"agy -p finished in {sw.ElapsedMilliseconds}ms, exit {proc.ExitCode}");
            return PrintResult(stdout, stderr, proc.ExitCode);
        }
        finally
        {
            try { if (proc is { HasExited: false }) proc.Kill(entireProcessTree: true); } catch { }
            proc?.Dispose();
            try { File.Delete(file); } catch { }
        }
    }

    /// <summary>Unwraps agy's JSON envelope, {"status":"SUCCESS","response":"..."}, into the answer text.</summary>
    internal static string PrintResult(string stdout, string stderr, int exitCode)
    {
        JsonElement envelope;
        try
        {
            envelope = JsonDocument.Parse(stdout).RootElement;
        }
        catch (JsonException)
        {
            var detail = FirstLine(stderr) ?? FirstLine(stdout) ?? $"exit code {exitCode}";
            throw new ApiProblem(502, "antigravity_failed", $"Antigravity CLI failed: {detail}");
        }

        var status = envelope.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        var response = envelope.TryGetProperty("response", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() ?? "" : "";
        if (!string.Equals(status, "SUCCESS", StringComparison.OrdinalIgnoreCase))
            throw new ApiProblem(502, "antigravity_failed", $"Antigravity CLI error: {FirstLine(response) ?? status ?? "unknown error"}");
        return response;
    }

    private static string? FirstLine(string text) =>
        text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();

    /// <summary>Runs agy away from any project and returns what it printed. Any failure reads as null.</summary>
    private async Task<string?> OutputOfAsync(string[] args, TimeSpan limit, CancellationToken ct)
    {
        if (Resolve() is not { } exe) return null;

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = Path.GetTempPath(),
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(limit);
        Process? proc = null;
        try
        {
            proc = Process.Start(psi);
            if (proc is null) return null;
            proc.StandardInput.Close();
            var stdout = await proc.StandardOutput.ReadToEndAsync(timeout.Token);
            await proc.WaitForExitAsync(timeout.Token);
            return stdout;
        }
        catch (Exception ex) when (ex is OperationCanceledException or InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
        {
            Log.Info($"agy {args[0]} failed: {ex.Message}");
            return null;
        }
        finally
        {
            try { if (proc is { HasExited: false }) proc.Kill(entireProcessTree: true); } catch { }
            proc?.Dispose();
        }
    }

    /// <summary>
    /// Picks the Antigravity model and level for a task of this complexity (1 to 10). Complexity 8 to 10 goes to Argon at
    /// high, 6 to 7 to Argon at medium, and 1 to 5 to Flash at medium. Only models in the list are used, so a plan
    /// without Argon sends everything to Flash, and a model without the wanted level gets the closest one it has.
    /// Claude and GPT models agy offers are never picked here. Null means no Argon or Flash model is available.
    /// </summary>
    public static (string Model, string? Effort)? PickModel(int complexity, IReadOnlyList<TerminalModel> models)
    {
        var allowed = models.Where(m => !ClaudeCli.IsPremium(m.Id)).ToList();
        var argon = allowed.FirstOrDefault(m => m.Id.Contains("argon", StringComparison.OrdinalIgnoreCase));
        var flash = allowed.FirstOrDefault(m => m.Id.Contains("flash", StringComparison.OrdinalIgnoreCase));
        complexity = Math.Clamp(complexity, 1, 10);

        if (complexity >= 6 && argon is not null) return (argon.Id, ClosestLevel(argon, complexity >= 8 ? "high" : "medium"));
        if (flash is not null) return (flash.Id, ClosestLevel(flash, "medium"));
        // No Flash: the simplest task still needs something, and Argon at its lowest level is the cheapest left.
        return argon is null ? null : (argon.Id, ClosestLevel(argon, complexity >= 8 ? "high" : "medium"));
    }

    /// <summary>The wanted level if the model has it, else the nearest one it has. Null when the model has no levels.</summary>
    internal static string? ClosestLevel(TerminalModel model, string wanted)
    {
        if (model.Efforts.Length == 0 || model.Efforts.Contains(wanted)) return model.Efforts.Length == 0 ? null : wanted;
        var at = Array.IndexOf(Terminals.EffortLevels, wanted);
        return model.Efforts.OrderBy(l => Math.Abs(Array.IndexOf(Terminals.EffortLevels, l) - at)).First();
    }

    /// <summary>
    /// Reads lines of "id, tab, label". Anything else is skipped. agy lists each level as its own model, such as
    /// gemini-4-argon-high, but refuses --effort next to an id with another level. So levels of a model become one
    /// entry with the plain id, which agy takes along with --effort.
    /// </summary>
    internal static List<TerminalModel> ParseModels(string text) =>
        text.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split('\t', 2, StringSplitOptions.TrimEntries))
            .Where(parts => parts.Length == 2 && parts[0].Length > 0 && parts[1].Length > 0)
            .Select(parts => SplitLevel(parts[0], parts[1]))
            .GroupBy(m => m.Id)
            .Select(g => new TerminalModel(g.Key, g.First().Label, Terminals.EffortLevels.Where(l => g.Any(m => m.Level == l)).ToArray()))
            .ToList();

    /// <summary>"gemini-4-argon-high", "Gemini 4 Argon (High)" gives the model and its level. A line without a level stays as it is.</summary>
    private static (string Id, string Label, string? Level) SplitLevel(string id, string label)
    {
        var match = LevelInLabel.Match(label);
        var level = match.Groups[2].Value.ToLowerInvariant();
        return match.Success && Terminals.EffortLevels.Contains(level) && id.EndsWith($"-{level}")
            ? (id[..^(level.Length + 1)], match.Groups[1].Value, level)
            : (id, label, null);
    }
}
