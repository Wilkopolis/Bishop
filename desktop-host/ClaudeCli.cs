using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Bishop;

public record TopicDraft(string Title, string Description, string Category, List<string> Tasks, List<int>? TaskComplexities = null, List<bool>? TaskUserActions = null);

/// <summary>One category's open topic titles, as Claude sees them.</summary>
public record CategoryTopics(string Name, List<string> Titles);

/// <summary>Claude's check of a draft: are its tasks enough to finish the topic, what's missing, what requires user action, and what only the user can answer.</summary>
public record TopicResearch(bool Sufficient, string Summary, List<string> Missing, List<string> Questions, List<string> UserActions)
{
    public List<string> Prerequisites => UserActions;
}

/// <summary>Refined topic title, description, newly identified tasks, and work requiring user action based on user answers.</summary>
public record TopicRefineResult(string Title, string Description, List<string> NewTasks, List<string> UserActions)
{
    public List<string> Prerequisites => UserActions;
}

/// <summary>One usage limit: percent used, and when it resets as the CLI words it.</summary>
public record UsageWindow(double Percent, string? Resets);

/// <summary>Claude plan usage. A window is null when there is no reading, e.g. offline or on an API key.</summary>
public record ClaudeUsage(UsageWindow? Session, UsageWindow? Week);

/// <summary>
/// Runs the Claude Code CLI in print mode to turn a voice transcript or pasted text
/// into proposed topics. The text goes over stdin, never argv.
/// </summary>
public sealed class ClaudeCli(string? configuredPath, string? model, AntigravityCli? antigravity = null)
{
    /// <summary>The Terminal's model choices. These are the CLI's aliases, so they always mean the latest of each.</summary>
    public static readonly TerminalModel[] TerminalModels =
    [
        new("fable", "Fable", Terminals.EffortLevels),
        new("opus", "Opus", Terminals.EffortLevels),
        new("sonnet", "Sonnet", Terminals.EffortLevels),
        new("haiku", "Haiku", Terminals.EffortLevels),
    ];

    /// <summary>Premium models that aren't on the user's plan. Delegating a task never picks them. They stay in the manual Terminal picker.</summary>
    internal static readonly string[] PremiumModels = ["fable"];

    /// <summary>True for a premium model id, such as "fable" or "claude-fable-5-1".</summary>
    internal static bool IsPremium(string id) =>
        PremiumModels.Any(p => id.Contains(p, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Picks a Claude model and reasoning level for a task's 1 to 10 complexity: 10 Fable xhigh, 8 to 9 Opus high, 6 to 7 Opus
    /// medium, 4 to 5 Sonnet medium, 3 Sonnet low. Levels 1 and 2 take Haiku low, then Sonnet low, and Opus medium
    /// only when neither is listed. Fable is picked only at level 10, and level 10 falls to Opus xhigh when Fable
    /// isn't listed. A missing model falls to the next one up, then down. A model
    /// without the wanted level takes the nearest it has. Returns null when none is listed.
    /// </summary>
    public static (string Model, string? Effort)? PickModel(int complexity, IReadOnlyList<TerminalModel> models)
    {
        complexity = Math.Clamp(complexity, 1, 10);
        var sonnetEffort = complexity == 3 ? "low" : "medium";
        var tiers = complexity <= 2
            ? new[] { ("haiku", "low"), ("sonnet", "low"), ("opus", "medium") }
            : complexity == 10
                ? new[] { ("haiku", "low"), ("sonnet", sonnetEffort), ("opus", "xhigh"), ("fable", "xhigh") }
                : new[] { ("haiku", "low"), ("sonnet", sonnetEffort), ("opus", complexity >= 8 ? "high" : "medium") };
        var want = complexity == 10 ? 3 : complexity >= 6 ? 2 : complexity >= 3 ? 1 : 0;
        // Try the wanted tier, then stronger ones, then weaker ones.
        foreach (var i in Enumerable.Range(want, tiers.Length - want).Concat(Enumerable.Range(0, want).Reverse()))
        {
            var model = models.FirstOrDefault(m => m.Id.Equals(tiers[i].Item1, StringComparison.OrdinalIgnoreCase));
            if (model is not null) return (model.Id, AntigravityCli.ClosestLevel(model, tiers[i].Item2));
        }
        return null;
    }

    /// <summary>The model and reasoning level the user picked in the top bar for background work. Null: use the configured model.</summary>
    private volatile BackgroundChoice? _background;

    private sealed record BackgroundChoice(string Model, string? Effort, bool Antigravity);

    /// <param name="service">"antigravity" runs background work through agy. Anything else means Claude.</param>
    public void SetBackground(string? backgroundModel, string? backgroundEffort, string? service = null)
    {
        var m = string.IsNullOrWhiteSpace(backgroundModel) ? null : backgroundModel.Trim();
        var e = m is not null && Terminals.EffortLevels.Contains(backgroundEffort ?? "") ? backgroundEffort : null;
        _background = m is null ? null : new BackgroundChoice(m, e, string.Equals(service, "antigravity", StringComparison.OrdinalIgnoreCase));
    }

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(120);
    // Research reads the project folder, so it takes longer than drafting.
    private static readonly TimeSpan ResearchTimeout = TimeSpan.FromSeconds(300);
    private static readonly TimeSpan UsageTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan UsageMaxAge = TimeSpan.FromSeconds(60);

    private readonly SemaphoreSlim _usageGate = new(1, 1);
    private ClaudeUsage _usage = new(null, null);
    private DateTime _usageAt = DateTime.MinValue;
    private bool _usageUnsupported;

    private const string Instructions = """
        You turn a note about a software or personal project into topics for a project management app.
        The input on stdin has the project name and the note: a raw voice transcript or pasted text, which may
        ramble or contain filler words.

        Respond with ONLY a JSON object. No markdown, no code fences, no commentary. Exact shape:
        {"topics": [{"title": string, "description": string, "tasks": [{"title": string, "complexity": number, "userAction": boolean}]}]}

        Rules:
        - topics: one topic for each unrelated request in the note, in the order the note mentions them.
          Two requests are unrelated when each could be done, shipped or dropped without the other, such as
          a bug fix and a separate new feature. Steps, details or sub-parts of one piece of work are a single
          request, however many there are, and so is an idea plus its reasons. If you're unsure, treat them
          as one request. A note about one thing gives exactly one topic.
          Use at most 10 topics: if the note holds more requests, merge the closest ones.
        - Every part of the note belongs to exactly one topic. Don't drop a request, and don't repeat one.
        - title: short and specific, at most 80 characters.
        - description: 1-3 plain sentences summarizing what this topic is about, not the rest of the note.
        - tasks: 0-12 short imperative action items for this topic that the note states or clearly implies.
          Don't invent extra work. Each task has a "title", a "complexity" and a "userAction" flag.
          Don't draft tasks the user would do by testing, such as playtesting or testing on a device, or by
          checking the result by hand. Leave those out.
        - userAction: true only for a task that needs art or audio assets from the user, or a decision the
          note leaves open that the user has to make before the work can start. Everything else is false,
          including agent tasks (writing or changing code). Tasks marked true become prerequisites: the agent
          tasks wait until the user has done them. Use false when unsure.
        - complexity: an integer from 1 to 10 rating how complex the task is to implement. Use the levels of
          the user's effort table, since each level picks the model and reasoning effort the task runs with:
          1-2 = trivial, Haiku or Sonnet at low effort (copy, rename or style tweak);
          3-4 = small, Sonnet at low to medium effort (single-file change or simple UI control);
          5-6 = moderate, Sonnet or Opus at medium effort (change across a few files, state or API wiring);
          7-8 = complex, Opus at medium to high effort (multi-file feature, schema migration or tricky logic);
          9 = very complex, Opus or Fable at high to xhigh effort (architectural work);
          10 = the hardest, Fable or Opus at high to xhigh effort (intricate algorithms or large cross-cutting rewrites).
          Rate the task itself, not how long it would take a person.
        - Write in the same language as the note.
        - The input may list the project's existing topics by category. Don't duplicate one: if the note is
          about an existing topic, give the new topic a clearly different title and mention the related
          existing topic in the description.
        - If you were given project instructions (for example from AGENTS.md), follow them, but always answer
          with the JSON object above and nothing else.
        """;

    private const string ResearchInstructions = """
        You check a proposed topic for a project management app. A topic is a piece of work and its tasks are
        the checklist for it. Decide whether finishing every task would accomplish the topic, find what the
        user still needs to decide before the work can start, and identify work that requires user action.
        The input on stdin has the project name, the project's existing topics, and the proposed topic.
        If you have file tools, you are in the project's folder: read what you need to judge the work, but
        keep it brief. You can't change anything.

        Respond with ONLY a JSON object. No markdown, no code fences, no commentary. Exact shape:
        {"sufficient": boolean, "summary": string, "missing": string[], "questions": string[], "userActions": string[]}

        Rules:
        - sufficient: true when the tasks cover everything the title and description ask for. Judge only that:
          don't ask for extra polish, tests or documentation unless the topic or the project instructions
          call for them.
        - A topic with no tasks is not sufficient, unless it needs no work.
        - Work that an existing topic already covers isn't missing.
        - missing: when not sufficient, up to 8 short imperative tasks that would close the gaps, in the same
          style as the topic's tasks. Otherwise an empty array.
        - questions: up to 5 short clarifying questions only the user can answer, most important first. Ask
          only when the answer would change the work: the topic is ambiguous, or it leaves a real choice open.
          Don't ask what the project's files, the project instructions or a sensible default already settle,
          and don't ask about polish. Write each as one plain question addressed to the user. Most topics
          need none: use an empty array then. Questions don't change whether the tasks are sufficient.
        - userActions: up to 8 short items identifying work that requires user action (such as creating art assets,
          playtesting, testing on device, manual configuration or third-party signups) listed separately as prerequisites
          that must be done before the tasks can be done. Distinguish work that a human must do from work an agent or developer can
          implement directly. If no work requires user action, use an empty array.
        - summary: 1-2 plain sentences saying why the tasks are or aren't enough.
        - Write in the same language as the topic.
        - If you were given project instructions (for example from AGENTS.md), follow them, but always answer
          with the JSON object above and nothing else.
        """;

    private const string ReviewInstructions = """
        You review an existing topic for a project management app to help refine it. A topic is a piece of work
        and its tasks are the checklist for it. Review the topic's title, description and tasks for missing
        details. Decide whether finishing every task would accomplish the topic, identify what is missing,
        identify any work that requires user action, and, only when the tasks are not enough, ask clarifying
        questions to fill in what is missing before work starts.
        The input on stdin has the project name, the project's existing topics, the topic being reviewed, and
        any user answers or clarifications provided so far.
        If you have file tools, you are in the project's folder: read what you need to judge the work, but
        keep it brief. You can't change anything.

        Respond with ONLY a JSON object. No markdown, no code fences, no commentary. Exact shape:
        {"sufficient": boolean, "summary": string, "missing": string[], "questions": string[], "userActions": string[]}

        Rules:
        - sufficient: true when the tasks cover everything the title and description ask for. Judge only that:
          don't ask for extra polish, tests or documentation unless the topic or the project instructions
          call for them.
        - A topic with no tasks is not sufficient, unless it needs no work.
        - Work that an existing topic already covers isn't missing.
        - missing: when not sufficient, up to 8 short imperative tasks that would close the gaps, in the same
          style as the topic's tasks. Otherwise an empty array.
        - questions: when sufficient is true, always an empty array. Otherwise up to 5 short clarifying
          questions to ask the user to fill in what is missing, resolve ambiguities, or clarify decisions
          needed before the work can start, most important first. Don't ask what the project's files, project
          instructions or existing answers already settle. Write each as one plain question addressed to the
          user. If the topic needs no further input, use an empty array.
        - userActions: up to 8 short items identifying work that requires user action (such as creating art assets,
          playtesting, testing on device, manual configuration or third-party signups) listed separately as prerequisites
          that must be done before the tasks can be done. Distinguish work that a human must do from work an agent or developer can
          implement directly. If no work requires user action, use an empty array.
        - summary: 1-2 plain sentences saying why the tasks are or aren't enough.
        - Write in the same language as the topic.
        - If you were given project instructions (for example from AGENTS.md), follow them, but always answer
          with the JSON object above and nothing else.
        """;

    private const string RefineInstructions = """
        You refine an existing topic for a project management app based on user answers to clarifying questions.
        A topic is a piece of work and its tasks are the checklist for it.
        The input on stdin has the project name, the project's existing topics, the topic under refinement
        (title, description, existing tasks), and the user's answers and clarifications.
        If you have file tools, you are in the project's folder: read what you need to judge the work, but
        keep it brief. You can't change anything.

        Update the topic's title and description to incorporate the user's answers and decisions, provide
        any new tasks needed to fill in what was missing and accomplish the work clarified by the answers, and
        identify any work that requires user action.
        Keep existing tasks in mind: do NOT repeat or duplicate existing tasks in the new tasks list.

        Respond with ONLY a JSON object. No markdown, no code fences, no commentary. Exact shape:
        {"title": string, "description": string, "newTasks": string[], "userActions": string[]}

        Rules:
        - title: short and specific, at most 80 characters. Refine the title if the answers clarify its scope,
          otherwise keep the current title.
        - description: 1-3 plain sentences summarizing what this topic is about, incorporating the user's answers,
          decisions, and clarifications into the topic description.
        - newTasks: 0-8 short imperative action items that should be added to the topic checklist to accomplish
          what the user's answers call for and fill in missing gaps. Do NOT repeat tasks that already exist on the
          topic. If no new tasks are needed, use an empty array.
        - userActions: 0-8 short items identifying work that requires user action (such as creating art assets,
          playtesting, testing on device, manual configuration or third-party signups) listed separately as prerequisites
          that must be done before the tasks can be done. If no user actions are needed, use an empty array.
        - Write in the same language as the topic.
        - If you were given project instructions (for example from AGENTS.md), follow them, but always answer
          with the JSON object above and nothing else.
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

    /// <param name="projectFolder">The project's folder; Claude runs there so it reads AGENTS.md. Null runs in a temp folder.</param>
    /// <param name="existingTopics">Existing topic titles by category, so Claude can avoid duplicates.</param>
    public async Task<List<TopicDraft>> TopicFromTranscriptAsync(
        string projectName,
        string? tagline,
        IReadOnlyList<CategoryTopics> existingTopics,
        string transcript,
        string? projectFolder,
        CancellationToken ct)
    {
        var answer = await RunAsync(
            Instructions,
            "Create the topic JSON for the note on stdin.",
            tools: "",
            BuildInput(projectName, tagline, existingTopics, transcript),
            projectFolder,
            Timeout,
            ct);
        return ParseDrafts(answer);
    }

    /// <summary>Has Claude check whether a draft's tasks are enough to accomplish it, and what the user still needs to answer.</summary>
    /// <param name="projectFolder">The project's folder; Claude runs there and may read it. Null runs in a temp folder with no tools.</param>
    /// <param name="existingTopics">Existing topic titles by category, so work planned elsewhere doesn't count as missing.</param>
    public async Task<TopicResearch> ResearchTopicAsync(
        string projectName,
        string? tagline,
        IReadOnlyList<CategoryTopics> existingTopics,
        TopicDraft draft,
        string? projectFolder,
        CancellationToken ct)
    {
        var answer = await RunAsync(
            ResearchInstructions,
            "Check the proposed topic on stdin and answer with the JSON.",
            // Read-only tools only. Without a project folder there's nothing to read.
            tools: projectFolder is null ? "" : "Read,Glob,Grep",
            BuildResearchInput(projectName, tagline, existingTopics, draft),
            projectFolder,
            ResearchTimeout,
            ct);
        return ParseResearch(answer);
    }

    /// <summary>Reviews a topic's title, description and tasks for missing details, and asks clarifying questions to fill in what's missing.</summary>
    public async Task<TopicResearch> ReviewTopicAsync(
        string projectName,
        string? tagline,
        IReadOnlyList<CategoryTopics> existingTopics,
        TopicDraft draft,
        string? projectFolder,
        IReadOnlyList<string>? clarifications,
        CancellationToken ct)
    {
        var answer = await RunAsync(
            ReviewInstructions,
            "Review the topic on stdin, check for missing details, and ask clarifying questions in the JSON.",
            tools: projectFolder is null ? "" : "Read,Glob,Grep",
            BuildReviewInput(projectName, tagline, existingTopics, draft, clarifications),
            projectFolder,
            ResearchTimeout,
            ct);
        return ParseResearch(answer);
    }

    /// <summary>Updates a topic's title, description and checklist based on user answers to clarifying questions.</summary>
    public async Task<TopicRefineResult> RefineTopicAsync(
        string projectName,
        string? tagline,
        IReadOnlyList<CategoryTopics> existingTopics,
        TopicDraft draft,
        string? projectFolder,
        IReadOnlyList<string>? clarifications,
        CancellationToken ct)
    {
        var answer = await RunAsync(
            RefineInstructions,
            "Refine the topic on stdin with the user's answers and return the JSON.",
            tools: projectFolder is null ? "" : "Read,Glob,Grep",
            BuildReviewInput(projectName, tagline, existingTopics, draft, clarifications),
            projectFolder,
            ResearchTimeout,
            ct);
        return ParseRefinement(answer, draft.Title, draft.Description, draft.Tasks);
    }

    /// <summary>Runs one print-mode prompt and returns Claude's answer text. The input goes over stdin.</summary>
    private async Task<string> RunAsync(
        string instructions,
        string prompt,
        string tools,
        string input,
        string? projectFolder,
        TimeSpan limit,
        CancellationToken ct)
    {
        if (_background is { Antigravity: true } agyChoice)
        {
            if (antigravity is null) throw new ApiProblem(503, "antigravity_missing", "The Antigravity CLI isn't available.");
            // agy has no tool switch, so the read-only mode stands in for the tool list. It can't read stdin, so the
            // instructions and input go in a temp file (see AntigravityCli.PrintAsync).
            return await antigravity.PrintAsync(instructions + "\n\nInput:\n\n" + input, projectFolder, agyChoice.Model, agyChoice.Effort, limit, ct);
        }

        var exe = Resolve() ?? throw new ApiProblem(503, "claude_missing",
            "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, or set \"claudePath\" in settings.json.");

        // Bishop's own files (the prompt) stay in temp; nothing is written to the project folder.
        var tempDir = Path.Combine(Path.GetTempPath(), "Bishop-claude");
        Directory.CreateDirectory(tempDir);
        var workDir = projectFolder ?? tempDir;

        var psi = StartInfo(exe, workDir); // Claude Code picks up AGENTS.md / CLAUDE.md from here
        // Instructions go in a file: a .cmd shim runs through cmd.exe, which would mangle
        // multi-line text with quotes and pipes on the command line.
        // The name is unique because several drafts can be researched at once.
        var promptFile = Path.Combine(tempDir, $"prompt-{Guid.NewGuid():N}.txt");
        await File.WriteAllTextAsync(promptFile, instructions, ct);
        try
        {
            foreach (var arg in new[]
                     {
                         "-p", prompt,
                         "--system-prompt-file", promptFile,
                         "--output-format", "json",
                         "--tools", tools,
                         "--strict-mcp-config",
                         "--no-session-persistence",
                     })
                psi.ArgumentList.Add(arg);
            var choice = _background;
            var picked = choice?.Model;
            var effort = choice?.Effort;
            var useModel = picked ?? model;
            if (!string.IsNullOrEmpty(useModel))
            {
                psi.ArgumentList.Add("--model");
                psi.ArgumentList.Add(useModel);
            }
            if (picked is not null && effort is not null)
            {
                psi.ArgumentList.Add("--effort");
                psi.ArgumentList.Add(effort);
            }

            var sw = Stopwatch.StartNew();
            using var proc = Process.Start(psi) ?? throw new ApiProblem(500, "claude_failed", "Couldn't start the Claude CLI.");
            var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = proc.StandardError.ReadToEndAsync(ct);
            await proc.StandardInput.WriteAsync(input);
            proc.StandardInput.Close();

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(limit);
            try
            {
                await proc.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                if (ct.IsCancellationRequested) throw;
                throw new ApiProblem(504, "claude_timeout", $"Claude CLI didn't answer within {limit.TotalSeconds:F0} seconds.");
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            Log.Info($"claude -p finished in {sw.ElapsedMilliseconds}ms, exit {proc.ExitCode}");
            return ResultText(stdout, stderr, proc.ExitCode);
        }
        finally
        {
            try { File.Delete(promptFile); } catch { }
        }
    }

    /// <summary>
    /// Reads session and weekly usage from the CLI's /usage command. It runs locally, so it spends no
    /// tokens, and Bishop never touches the CLI's credentials. Any failure reads as "no data".
    /// </summary>
    public async Task<ClaudeUsage> UsageAsync(CancellationToken ct)
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

    private async Task<ClaudeUsage> ReadUsageAsync(CancellationToken ct)
    {
        var none = new ClaudeUsage(null, null);
        if (Resolve() is not { } exe) return none;

        var tempDir = Path.Combine(Path.GetTempPath(), "Bishop-claude");
        Directory.CreateDirectory(tempDir);
        var psi = StartInfo(exe, tempDir);
        foreach (var arg in new[] { "-p", "/usage", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence" })
            psi.ArgumentList.Add(arg);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(UsageTimeout);
        Process? proc = null;
        try
        {
            proc = Process.Start(psi);
            if (proc is null) return none;
            proc.StandardInput.Close();
            var stderrTask = proc.StandardError.ReadToEndAsync(timeout.Token);
            var stdout = await proc.StandardOutput.ReadToEndAsync(timeout.Token);
            await stderrTask;
            await proc.WaitForExitAsync(timeout.Token);

            var envelope = JsonDocument.Parse(stdout).RootElement;
            // An older CLI hands "/usage" to the model as a prompt. Don't keep spending tokens on that.
            if (!envelope.TryGetProperty("local_command", out var cmd) || cmd.GetString() != "usage")
            {
                _usageUnsupported = true;
                Log.Info("claude -p /usage isn't a local command in this CLI; the usage meter stays empty");
                return none;
            }
            return ParseUsage(envelope.GetProperty("result").GetString() ?? "");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Log.Info("claude -p /usage timed out");
            return none;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or System.ComponentModel.Win32Exception or IOException)
        {
            Log.Info($"claude -p /usage failed: {ex.Message}");
            return none;
        }
        finally
        {
            try { if (proc is { HasExited: false }) proc.Kill(entireProcessTree: true); } catch { }
            proc?.Dispose();
        }
    }

    /// <summary>Reads lines like "Current session: 64% used, resets Nov 3, 11:40pm (America/New_York)", with a middle dot for the comma.</summary>
    internal static ClaudeUsage ParseUsage(string text)
    {
        UsageWindow? Window(string label)
        {
            var m = Regex.Match(text, $@"^\s*{Regex.Escape(label)}:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^(\r\n]+))?", RegexOptions.Multiline);
            if (!m.Success) return null;
            var resets = m.Groups[2].Value.Trim();
            return new UsageWindow(double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), resets.Length > 0 ? resets : null);
        }
        return new ClaudeUsage(Window("Current session"), Window("Current week (all models)"));
    }

    private static ProcessStartInfo StartInfo(string exe, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = workDir,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = Encoding.UTF8,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        // Running on Windows via a .cmd wrapper needs cmd.exe /c.
        if (exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = "cmd.exe";
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(exe);
        }
        return psi;
    }

    internal static string BuildInput(string projectName, string? tagline, IReadOnlyList<CategoryTopics> existingTopics, string transcript)
    {
        var sb = new StringBuilder();
        AppendProject(sb, projectName, tagline, existingTopics);
        sb.Append("\nTranscript:\n").Append(transcript).Append('\n');
        return sb.ToString();
    }

    internal static string BuildResearchInput(string projectName, string? tagline, IReadOnlyList<CategoryTopics> existingTopics, TopicDraft draft)
    {
        var sb = new StringBuilder();
        AppendProject(sb, projectName, tagline, existingTopics);
        sb.Append("\nProposed topic:\nTitle: ").Append(draft.Title).Append('\n');
        if (!string.IsNullOrWhiteSpace(draft.Description)) sb.Append("Description: ").Append(draft.Description).Append('\n');
        sb.Append("Tasks:").Append(draft.Tasks.Count > 0 ? "\n" : " (none)\n");
        foreach (var task in draft.Tasks) sb.Append("- ").Append(task).Append('\n');
        return sb.ToString();
    }

    internal static string BuildReviewInput(string projectName, string? tagline, IReadOnlyList<CategoryTopics> existingTopics, TopicDraft draft, IReadOnlyList<string>? clarifications = null)
    {
        var sb = new StringBuilder();
        AppendProject(sb, projectName, tagline, existingTopics);
        sb.Append("\nTopic under review:\nTitle: ").Append(draft.Title).Append('\n');
        if (!string.IsNullOrWhiteSpace(draft.Description)) sb.Append("Description: ").Append(draft.Description).Append('\n');
        sb.Append("Tasks:").Append(draft.Tasks.Count > 0 ? "\n" : " (none)\n");
        foreach (var task in draft.Tasks) sb.Append("- ").Append(task).Append('\n');
        if (clarifications is { Count: > 0 })
        {
            sb.Append("\nUser answers and clarifications:\n");
            foreach (var c in clarifications) sb.Append("- ").Append(c).Append('\n');
        }
        return sb.ToString();
    }

    private static void AppendProject(StringBuilder sb, string projectName, string? tagline, IReadOnlyList<CategoryTopics> existingTopics)
    {
        sb.Append("Project: ").Append(projectName).Append('\n');
        if (!string.IsNullOrWhiteSpace(tagline)) sb.Append("Tagline: ").Append(tagline).Append('\n');
        var any = existingTopics.Any(c => c.Titles.Count > 0);
        sb.Append("\nExisting topics:").Append(any ? "\n" : " (none)\n");
        foreach (var category in existingTopics.Where(c => c.Titles.Count > 0))
            sb.Append("- ").Append(category.Name).Append(": ").Append(string.Join("; ", category.Titles.Take(60))).Append('\n');
    }

    /// <summary>Unwraps the CLI's JSON envelope into the model's answer text.</summary>
    internal static string ResultText(string stdout, string stderr, int exitCode)
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

        return result;
    }

    /// <summary>Finds the JSON object in the model's answer; tolerates code fences and surrounding text.</summary>
    private static JsonElement ParseAnswer(string text)
    {
        var cleaned = Regex.Replace(text.Trim(), @"^```[a-zA-Z]*\s*|\s*```$", "");
        var start = cleaned.IndexOf('{');
        var end = cleaned.LastIndexOf('}');
        if (start < 0 || end <= start)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer didn't contain JSON.");

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
        return obj;
    }

    /// <summary>Strictly parse the model's answer into drafts.</summary>
    internal static List<TopicDraft> ParseDrafts(string text)
    {
        var obj = ParseAnswer(text);
        if (!obj.TryGetProperty("topics", out var topics) || topics.ValueKind != JsonValueKind.Array || topics.GetArrayLength() == 0)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer had no topics.");

        return topics.EnumerateArray().Take(10).Select(ParseDraft).ToList();
    }

    /// <summary>A missing verdict fails the answer: guessing one could tell the user the tasks are fine when nobody checked.</summary>
    internal static TopicResearch ParseResearch(string text)
    {
        var obj = ParseAnswer(text);
        if (!obj.TryGetProperty("sufficient", out var verdict) || verdict.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer had no verdict on the tasks.");

        var missing = StringList(obj, "missing");
        var summary = obj.TryGetProperty("summary", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : "";
        var userActions = StringList(obj, "prerequisites");
        if (userActions.Count == 0) userActions = StringList(obj, "userActions");
        if (userActions.Count == 0) userActions = StringList(obj, "user_actions");

        // Listed gaps outweigh the flag, so the two can't disagree in the UI.
        var sufficient = verdict.GetBoolean() && missing.Count == 0;
        // A sufficient topic needs no input from the user, so drop any questions.
        var questions = sufficient ? [] : StringList(obj, "questions").Take(5).ToList();
        return new TopicResearch(
            sufficient,
            summary,
            missing.Take(8).ToList(),
            questions,
            userActions.Take(8).ToList());
    }

    /// <summary>Strictly parses refined topic title, description, new tasks, and work requiring user action.</summary>
    internal static TopicRefineResult ParseRefinement(string text, string fallbackTitle, string fallbackDescription, IReadOnlyList<string> existingTasks)
    {
        var obj = ParseAnswer(text);
        var title = obj.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String && t.GetString()!.Trim() is { Length: > 0 } s ? s : fallbackTitle;
        var description = obj.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString()!.Trim() : fallbackDescription;

        var existingSet = new HashSet<string>(existingTasks.Select(x => x.Trim()), StringComparer.OrdinalIgnoreCase);
        var newTasks = new List<string>();

        var taskList = StringList(obj, "newTasks");
        if (taskList.Count == 0) taskList = StringList(obj, "tasks");

        foreach (var task in taskList)
        {
            if (existingSet.Add(task))
                newTasks.Add(task);
        }

        var userActions = StringList(obj, "prerequisites");
        if (userActions.Count == 0) userActions = StringList(obj, "userActions");
        if (userActions.Count == 0) userActions = StringList(obj, "user_actions");

        return new TopicRefineResult(title, description, newTasks.Take(8).ToList(), userActions.Take(8).ToList());
    }

    /// <summary>Fallback heuristic to detect work requiring user action from tasks and clarifications when Claude is unavailable.</summary>
    internal static List<string> IdentifyUserActionsFallback(TopicDraft draft, IReadOnlyList<string>? clarifications)
    {
        var actions = new List<string>();
        var candidates = new List<string>();
        candidates.AddRange(draft.Tasks);
        if (clarifications is not null) candidates.AddRange(clarifications);

        var patterns = new[] { "art asset", "playtest", "play-test", "user testing", "manual test", "draw ", "drawing", "paint ", "record audio", "record voice", "voiceover", "voice-over", "3d model", "sprite", "prerequisite" };
        foreach (var c in candidates)
        {
            var lower = c.ToLowerInvariant();
            if (patterns.Any(p => lower.Contains(p)))
            {
                actions.Add(c.Trim());
            }
        }
        return actions.Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList();
    }

    /// <summary>The non-blank strings in an array property. Anything else in it is skipped.</summary>
    private static List<string> StringList(JsonElement obj, string name)
    {
        var items = new List<string>();
        if (obj.TryGetProperty(name, out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && item.GetString()!.Trim() is { Length: > 0 } s)
                    items.Add(s);
            }
        }
        return items;
    }

    /// <summary>Rates a task's complexity from 1 to 10 when Claude didn't supply a number.</summary>
    public static int RateTaskComplexity(string? title)
    {
        var text = (title ?? "").Trim().ToLowerInvariant();
        if (text.Length == 0) return 3;

        int score = 4;

        var trivial = new[] { "rename", "typo", "copy", "label", "tooltip", "placeholder", "padding", "margin", "align", "center", "spacing", "border", "pixel", "px", "font", "tint", "remove button", "remove the", "hide " };
        var simple = new[] { "button", "dropdown", "badge", "indicator", "dot", "checkbox", "input", "header", "footer", "color", "icon", "show ", "display ", "exclude", "filter", "sort" };
        var moderate = new[] { "endpoint", "api", "store", "state", "persist", "save", "load", "fetch", "context", "validation", "map ", "mapping", "setting", "family", "delegate", "delegating", "choose", "automatically", "import", "export", "search", "queue", "modal", "dialog" };
        var complex = new[] { "schema", "migration", "database", "sqlite", "trigger", "backfill", "websocket", "terminal", "session", "conpty", "pty", "whisper", "transcribe", "stream", "concurrent", "synchroniz", "drag and drop", "reorder", "refactor", "architecture", "integration", "security", "algorithm", "parse" };
        var veryComplex = new[] { "end-to-end", "distributed", "engine", "full-text", "real-time", "multi-agent", "orchestrat", "overhaul", "rewrite" };

        if (trivial.Any(text.Contains)) score -= 2;
        if (simple.Any(text.Contains)) score = Math.Max(score, 3);
        int modHits = moderate.Count(text.Contains);
        if (modHits > 0) score = Math.Max(score, 5) + Math.Min(1, modHits - 1);
        int compHits = complex.Count(text.Contains);
        if (compHits > 0) score = Math.Max(score, 7) + Math.Min(2, compHits - 1);
        if (veryComplex.Any(text.Contains)) score = Math.Max(score, 9);

        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        if (words <= 4 && compHits == 0 && modHits == 0) score = Math.Min(score, 3);
        else if (words >= 12) score += 1;

        return Math.Clamp(score, 1, 10);
    }

    private static int ParseComplexityValue(JsonElement el, string fallbackTitle)
    {
        if (el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var n) && !double.IsNaN(n) && !double.IsInfinity(n))
            return Math.Clamp((int)Math.Round(n), 1, 10);
        if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
            return Math.Clamp((int)Math.Round(parsed), 1, 10);
        return RateTaskComplexity(fallbackTitle);
    }

    /// <summary>A topic with no title fails the whole answer: skipping it would silently lose part of the note.</summary>
    private static TopicDraft ParseDraft(JsonElement obj)
    {
        if (obj.ValueKind != JsonValueKind.Object)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer had a topic that wasn't a JSON object.");

        string Str(string name) =>
            obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : "";

        var title = Str("title");
        if (title.Length == 0)
            throw new ApiProblem(502, "claude_bad_output", "Claude's answer had a topic with no title.");
        if (title.Length > 120) title = title[..120].TrimEnd();

        var tasks = new List<string>();
        var complexities = new List<int>();
        var userActions = new List<bool>();
        var parallelComplexities = new List<JsonElement>();
        if (obj.TryGetProperty("taskComplexities", out var tcArr) && tcArr.ValueKind == JsonValueKind.Array)
            parallelComplexities.AddRange(tcArr.EnumerateArray());
        else if (obj.TryGetProperty("complexities", out var cArr) && cArr.ValueKind == JsonValueKind.Array)
            parallelComplexities.AddRange(cArr.EnumerateArray());

        if (obj.TryGetProperty("tasks", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            int idx = 0;
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && item.GetString()!.Trim() is { Length: > 0 } s)
                {
                    tasks.Add(s);
                    userActions.Add(false);
                    complexities.Add(idx < parallelComplexities.Count
                        ? ParseComplexityValue(parallelComplexities[idx], s)
                        : RateTaskComplexity(s));
                }
                else if (item.ValueKind == JsonValueKind.Object)
                {
                    var taskTitle = item.TryGetProperty("title", out var tt) && tt.ValueKind == JsonValueKind.String ? tt.GetString()!.Trim()
                        : item.TryGetProperty("task", out var tk) && tk.ValueKind == JsonValueKind.String ? tk.GetString()!.Trim()
                        : item.TryGetProperty("name", out var tn) && tn.ValueKind == JsonValueKind.String ? tn.GetString()!.Trim()
                        : "";
                    if (taskTitle.Length > 0)
                    {
                        tasks.Add(taskTitle);
                        userActions.Add(item.TryGetProperty("userAction", out var ua) && ua.ValueKind == JsonValueKind.True
                            || item.TryGetProperty("user_action", out var ua2) && ua2.ValueKind == JsonValueKind.True);
                        if (item.TryGetProperty("complexity", out var cx))
                            complexities.Add(ParseComplexityValue(cx, taskTitle));
                        else if (idx < parallelComplexities.Count)
                            complexities.Add(ParseComplexityValue(parallelComplexities[idx], taskTitle));
                        else
                            complexities.Add(RateTaskComplexity(taskTitle));
                    }
                }
                idx++;
            }
        }

        // Claude doesn't pick the category, whatever the urgency in the note. The API sets it to the project's first category.
        return new TopicDraft(title, Str("description"), "", tasks.Take(20).ToList(), complexities.Take(20).ToList(), userActions.Take(20).ToList());
    }

    private static string? FirstLine(string s) =>
        s.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
}
