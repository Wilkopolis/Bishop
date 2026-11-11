using System.Collections.Concurrent;
using System.ComponentModel;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Porta.Pty;

namespace Bishop;

/// <summary>
/// Windows Job Object with KILL_ON_JOB_CLOSE. Terminal processes are added to it, so if Bishop
/// exits (even by crashing) Windows kills them and everything they started.
/// </summary>
public sealed class KillOnCloseJob
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int PROCESS_SET_QUOTA = 0x0100, PROCESS_TERMINATE = 0x0001;

    // Never closed explicitly: the handle closes when Bishop's process ends, which kills the job.
    private readonly IntPtr _job;

    public KillOnCloseJob()
    {
        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) throw new Win32Exception();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
            throw new Win32Exception();
    }

    public void Add(int pid)
    {
        var h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (h == IntPtr.Zero)
        {
            Log.Info($"Couldn't open pid {pid} for the job: {Marshal.GetLastWin32Error()}");
            return;
        }
        try
        {
            if (!AssignProcessToJobObject(_job, h)) Log.Info($"Couldn't add pid {pid} to job: {Marshal.GetLastWin32Error()}");
        }
        finally
        {
            CloseHandle(h);
        }
    }
}

public enum TerminalKind { Claude, Antigravity, Shell }

public record TerminalInfo(string Id, long ProjectId, string Kind, string Title, string Cwd, bool Alive, int? ExitCode, bool Used, long? TopicId, long? TaskId, string? TaskTitle, bool TaskRunning, DateTimeOffset? TaskFinishedAt, bool Background, DateTimeOffset? EndedAt, string? Model, string? Effort, DateTimeOffset LastActivityAt);

/// <summary>A model the Terminal can start a CLI on. The id goes to the CLI's --model flag, a level from Efforts to --effort.</summary>
public record TerminalModel(string Id, string Label, string[] Efforts);

/// <summary>A Claude or Antigravity session started on a task has marked that task as done.</summary>
/// <param name="StartedAt">When the session took on the task.</param>
/// <param name="Duration">Time from start to the CLI's report. Null if the start isn't known.</param>
/// <param name="Tokens">Tokens the CLI used on the task, from its transcript. Null when it can't be read.</param>
public record TaskCompletion(string SessionId, long ProjectId, long TaskId, string TaskTitle, DateTimeOffset? StartedAt = null, TimeSpan? Duration = null, TaskTokens? Tokens = null, string? Model = null, string? Effort = null, TerminalKind Kind = TerminalKind.Claude);

/// <summary>One pseudo-terminal running claude, agy or a shell in a project folder. It outlives its process, so its scrollback can still be read.</summary>
public sealed class TerminalSession : IDisposable
{
    private const int MaxScrollback = 512 * 1024;

    private readonly IPtyConnection _pty;
    private readonly StringBuilder _scrollback = new();
    private readonly object _gate = new();
    private readonly Decoder _decoder = new UTF8Encoding(false).GetDecoder();
    private WebSocket? _socket;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private int _disposed;

    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long ProjectId { get; }
    public TerminalKind Kind { get; }
    public string Title { get; private set; }
    public string Cwd { get; }
    /// <summary>The Claude conversation in this session. Only sessions started on a task have one.</summary>
    public string? ClaudeSessionId { get; }
    /// <summary>The model the CLI was started on. Null: the CLI's own default.</summary>
    public string? Model { get; }
    /// <summary>The reasoning level the CLI was started on. Null: the CLI's own default.</summary>
    public string? Effort { get; }
    /// <summary>The session's latest task, if any. In same session mode a session takes on one task after another.</summary>
    public long? TaskId { get; private set; }
    public string? TaskTitle { get; private set; }
    public long? TopicId { get; private set; }
    public DateTimeOffset? TaskStartedAt { get; private set; }
    /// <summary>When Claude first reported this session's task as done. The session may stay open after that.</summary>
    public DateTimeOffset? TaskFinishedAt { get; private set; }
    public bool TaskFinished => TaskFinishedAt is not null;
    /// <summary>How long the latest task took, from the session taking it on to Claude's report. Null until both are known.</summary>
    public TimeSpan? TaskDuration => TaskStartedAt is { } start && TaskFinishedAt is { } end ? end - start : null;
    /// <summary>
    /// The session keeps running, but it is no longer the Terminal's session for its project:
    /// the UI lets go of it, and starting another session leaves it alone. Reopening it brings it back.
    /// </summary>
    public bool Background { get; private set; }
    public void MarkTaskFinished()
    {
        TaskFinishedAt ??= DateTimeOffset.UtcNow;
        Background = true;
    }
    public void MoveToBackground() => Background = true;
    public void BringBack() => Background = false;
    /// <summary>The session moves on to another task. The feed shows it as working on that one now.</summary>
    public void TakeTask(TaskDto task, string title)
    {
        Title = title;
        TaskId = task.Id;
        TaskTitle = task.Title;
        TopicId = task.TopicId;
        TaskStartedAt = DateTimeOffset.UtcNow;
        TaskFinishedAt = null;
        Used = true;
        Touch(save: true);
    }
    /// <summary>
    /// Claude is still on its task. Ticking the task in the UI doesn't change this: only Claude's own
    /// report does, because Claude may still be working.
    /// </summary>
    public bool TaskRunning => Alive && TaskId is not null && !TaskFinished;
    public bool Alive { get; private set; } = true;
    public int? ExitCode { get; private set; }
    /// <summary>When the process ended, by itself or because the session was closed.</summary>
    public DateTimeOffset? EndedAt { get; private set; }
    private void MarkEnded()
    {
        Alive = false;
        EndedAt ??= DateTimeOffset.UtcNow;
        Touch(save: true);
    }
    /// <summary>
    /// False for a session nobody has touched yet, like the one the panel starts when it opens.
    /// Ending one of those loses nothing, so the UI doesn't ask first.
    /// </summary>
    public bool Used { get; private set; }

    private long _lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;
    /// <summary>
    /// When the session last did something: the CLI printed output, the user typed, a task was taken on or
    /// the process ended. It starts at the session's start. Saved to the sessions table, at most every 30 seconds.
    /// </summary>
    public DateTimeOffset LastActivityAt => new(Interlocked.Read(ref _lastActivityTicks), TimeSpan.Zero);
    private void Touch(bool save = false)
    {
        var now = DateTimeOffset.UtcNow.UtcTicks;
        Interlocked.Exchange(ref _lastActivityTicks, now);
        if (Persist is null) return;
        // Output is frequent, so routine activity is saved at most every 30 seconds. Starts, tasks and ends always save.
        if (!save && now - Interlocked.Read(ref _savedTicks) < SaveInterval.Ticks) return;
        Interlocked.Exchange(ref _savedTicks, now);
        try { Persist(this); } catch { }
    }

    private static readonly TimeSpan SaveInterval = TimeSpan.FromSeconds(30);
    private long _savedTicks;
    /// <summary>When the session started. Saved with the session record.</summary>
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
    /// <summary>Saves the session's record. Set by <see cref="Terminals"/>; runs on whichever thread had the activity, so it must be quick.</summary>
    public Action<TerminalSession>? Persist { get; set; }
    /// <summary>Saves the record now, e.g. right after the session starts.</summary>
    public void SaveNow() => Touch(save: true);

    private TerminalSession(IPtyConnection pty, long projectId, TerminalKind kind, string title, string cwd, TaskDto? task, string? claudeSessionId, string? model, string? effort)
    {
        _pty = pty;
        ProjectId = projectId;
        Kind = kind;
        Title = title;
        Cwd = cwd;
        ClaudeSessionId = claudeSessionId;
        Model = model;
        Effort = effort;
        if (task is not null) TakeTask(task, title);
        _pty.ProcessExited += (_, e) =>
        {
            MarkEnded();
            ExitCode = e.ExitCode;
            Log.Info($"Terminal exited: {title} (pid {_pty.Pid}, exit code {e.ExitCode})");
            _ = SendJsonAsync(new { type = "exit", code = e.ExitCode });
        };
        _ = Task.Run(ReadLoopAsync);
    }

    public TerminalInfo Info => new(Id, ProjectId, Kind.ToString().ToLowerInvariant(), Title, Cwd, Alive, ExitCode, Used, TopicId, TaskId, TaskTitle, TaskRunning, TaskFinishedAt, Background, EndedAt, Model, Effort, LastActivityAt);

    public static async Task<TerminalSession> StartAsync(long projectId, TerminalKind kind, string cwd, string app, string[] args, bool verbatim, string title, int cols, int rows, KillOnCloseJob? job, TaskDto? task = null, string? claudeSessionId = null, string? model = null, string? effort = null)
    {
        var env = new Dictionary<string, string>
        {
            ["TERM"] = "xterm-256color",
            ["COLORTERM"] = "truecolor",
        };
        var options = new PtyOptions
        {
            Name = title,
            App = app,
            CommandLine = args,
            VerbatimCommandLine = verbatim,
            Cwd = cwd,
            Cols = Math.Clamp(cols, 20, 500),
            Rows = Math.Clamp(rows, 5, 200),
            Environment = env,
        };
        var pty = await PtyProvider.SpawnAsync(options, CancellationToken.None);
        job?.Add(pty.Pid);
        Log.Info($"Terminal started: {title} (pid {pty.Pid}) in {cwd} [{options.Cols}x{options.Rows}]");
        Log.Info($"Terminal command: {app} {string.Join(" ", args)}");
        return new TerminalSession(pty, projectId, kind, title, cwd, task, claudeSessionId, model, effort);
    }

    private async Task ReadLoopAsync()
    {
        var buffer = new byte[16 * 1024];
        var chars = new char[buffer.Length + 8];
        var firstRead = true;
        try
        {
            while (true)
            {
                var n = await _pty.ReaderStream.ReadAsync(buffer);
                if (n <= 0) break;
                Touch();
                if (firstRead)
                {
                    firstRead = false;
                    Log.Info($"Terminal first output: {Title} ({n} bytes received from pty)");
                }
                string text;
                lock (_gate)
                {
                    // The decoder keeps partial UTF-8 sequences between reads.
                    var c = _decoder.GetChars(buffer, 0, n, chars, 0);
                    text = new string(chars, 0, c);
                    _scrollback.Append(text);
                    if (_scrollback.Length > MaxScrollback) _scrollback.Remove(0, _scrollback.Length - MaxScrollback);
                }
                if (text.Length > 0) await SendJsonAsync(new { type = "output", data = text });
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
        }
        MarkEnded();
    }

    public void Write(string data)
    {
        if (!Alive) return;
        var bytes = Encoding.UTF8.GetBytes(data);
        try
        {
            _pty.WriterStream.Write(bytes, 0, bytes.Length);
            _pty.WriterStream.Flush();
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
        }
    }

    public void Resize(int cols, int rows)
    {
        if (!Alive) return;
        try
        {
            _pty.Resize(Math.Clamp(cols, 20, 500), Math.Clamp(rows, 5, 200));
        }
        catch
        {
        }
    }

    /// <summary>Attaches a WebSocket (replacing any previous one) and replays the scrollback.</summary>
    public async Task AttachAsync(WebSocket socket, CancellationToken ct)
    {
        string replay;
        lock (_gate)
        {
            replay = _scrollback.ToString();
            _socket = socket;
        }
        Log.Info($"Terminal attached: {Title} (id {Id}, replaying {replay.Length} chars)");
        await SendJsonAsync(new { type = "replay", data = replay, alive = Alive, exitCode = ExitCode });

        var buffer = new byte[64 * 1024];
        var message = new MemoryStream();
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                HandleClientMessage(message.ToArray());
                message.SetLength(0);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
        }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_socket, socket)) _socket = null;
            }
        }
    }

    private void HandleClientMessage(byte[] json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "input":
                    var data = root.GetProperty("data").GetString() ?? "";
                    if (IsTyping(data))
                    {
                        Used = true;
                        Touch();
                    }
                    Write(data);
                    break;
                case "resize":
                    Resize(root.GetProperty("cols").GetInt32(), root.GetProperty("rows").GetInt32());
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
        }
    }

    /// <summary>
    /// xterm also sends input by itself (focus events, replies to terminal queries, mouse reports).
    /// Those start with ESC, as do arrow keys. A paste does too, but it is real input.
    /// </summary>
    private static bool IsTyping(string data) =>
        data.Length > 0 && (data[0] != '' || data.StartsWith("[200~", StringComparison.Ordinal));

    private async Task SendJsonAsync(object payload)
    {
        WebSocket? socket;
        lock (_gate) socket = _socket;
        if (socket is not { State: WebSocketState.Open }) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await _sendGate.WaitAsync();
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or OperationCanceledException)
        {
        }
        finally
        {
            _sendGate.Release();
        }
    }

    /// <summary>Ends the process. The session keeps its scrollback and can still be attached to.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        try
        {
            if (Alive) _pty.Kill();
        }
        catch
        {
        }
        try
        {
            _pty.Dispose();
        }
        catch
        {
        }
        MarkEnded();
    }
}

/// <summary>All terminal sessions, keyed by id. One "current" session per project is tracked by the UI.</summary>
public sealed class Terminals : IDisposable
{
    /// <summary>Ended sessions kept for the session feed. Each holds up to 1 MB of scrollback.</summary>
    private const int MaxEndedSessions = 50;
    /// <summary>Claude reads text and Enter arriving together as a paste, which adds a new line instead of sending.</summary>
    private static readonly TimeSpan SubmitDelay = TimeSpan.FromMilliseconds(300);
    /// <summary>The levels both CLIs take for --effort, lowest first.</summary>
    public static readonly string[] EffortLevels = ["low", "medium", "high", "xhigh", "max"];
    /// <summary>A model id can reach cmd.exe through a .cmd shim, so it stays plain.</summary>
    private static readonly Regex ModelId = new(@"^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,99}$");

    /// <summary>Empty means the CLI's own default.</summary>
    public static string? NormalizeModel(string? model)
    {
        if (string.IsNullOrEmpty(model)) return null;
        return ModelId.IsMatch(model) ? model : throw new ArgumentException("That model id isn't valid");
    }

    /// <summary>Empty means the CLI's own default.</summary>
    public static string? NormalizeEffort(string? effort)
    {
        if (string.IsNullOrEmpty(effort)) return null;
        return EffortLevels.Contains(effort) ? effort : throw new ArgumentException("That reasoning level isn't valid");
    }

    private readonly ConcurrentDictionary<string, TerminalSession> _sessions = new();
    private readonly ClaudeCli _claude;
    private readonly AntigravityCli _antigravity;
    private readonly string? _dataRoot;
    private readonly KillOnCloseJob? _job;

    /// <summary>
    /// Raised when a live Claude session finishes the task it was started on. Runs on the request
    /// thread of the API call, so handlers must return quickly and not touch the UI directly.
    /// </summary>
    public event Action<TaskCompletion>? TaskCompleted;

    /// <summary>
    /// Raised when a session's record should be saved: it started, took a task, ended, or was active (at most every 30 seconds).
    /// Runs on the thread that saw the activity, so handlers must return quickly.
    /// </summary>
    public event Action<TerminalInfo, DateTimeOffset>? SessionChanged;

    public Terminals(ClaudeCli claude, AntigravityCli antigravity, string? dataRoot = null)
    {
        _claude = claude;
        _antigravity = antigravity;
        _dataRoot = dataRoot;
        try
        {
            _job = new KillOnCloseJob();
        }
        catch (Exception ex)
        {
            Log.Info($"Job object unavailable; terminals will only be cleaned up on normal exit: {ex.Message}");
        }
    }

    public IEnumerable<TerminalInfo> List(long? projectId) =>
        _sessions.Values.Where(s => projectId is null || s.ProjectId == projectId).Select(s => s.Info);

    public TerminalSession? Get(string id) => _sessions.GetValueOrDefault(id);

    public Task<List<TerminalModel>> AntigravityModelsAsync(CancellationToken ct) => _antigravity.ModelsAsync(ct);

    public Task<AntigravityUsage> AntigravityUsageAsync(CancellationToken ct) => _antigravity.UsageAsync(ct);

    /// <summary>True when agy won't stop at its trust dialog here. With no agy there is no dialog: starting it reports that instead.</summary>
    public bool AntigravityTrusts(string folder) => _antigravity.Resolve() is null || _antigravity.IsTrusted(folder);

    public void TrustForAntigravity(string folder)
    {
        _antigravity.Trust(folder);
        if (_dataRoot is not null)
        {
            var workDir = Path.Combine(_dataRoot, "work");
            var contextDir = Path.Combine(_dataRoot, "context");
            Directory.CreateDirectory(workDir);
            Directory.CreateDirectory(contextDir);
            _antigravity.Trust(workDir);
            _antigravity.Trust(contextDir);
        }
    }

    /// <summary>The CLI, model and reasoning level of the session that last finished this task.</summary>
    public (TerminalKind Kind, string? Model, string? Effort) ChoiceOfFinishedTask(long projectId, long taskId)
    {
        var session = _sessions.Values.Where(s => s.ProjectId == projectId && s.TaskId == taskId).MaxBy(s => s.TaskFinishedAt);
        return (session?.Kind ?? TerminalKind.Claude, session?.Model, session?.Effort);
    }

    /// <summary>
    /// Call when Claude reports a task as done: its session moves to the background. Tasks with no live session are ignored.
    /// <paramref name="wasDone"/>: it was already ticked, so the session still moves but nothing is raised.
    /// Returns true when a live session finished its task just now.
    /// </summary>
    public bool ReportTaskCompleted(long projectId, TaskDto task, bool wasDone)
    {
        // A background session can outlive its task's next run, so the one still working comes first.
        var live = _sessions.Values.Where(s => s.Alive && s.ProjectId == projectId && s.TaskId == task.Id).ToList();
        if (live.Count == 0) return false;
        foreach (var s in live) s.MarkTaskFinished();
        var session = live.FirstOrDefault();
        if (wasDone) return false;
        var duration = session?.TaskDuration;
        var tokens = session?.TaskFinishedAt is { } finished
            ? session.Kind switch
            {
                TerminalKind.Claude => TaskUsage.Read(session.Cwd, session.ClaudeSessionId, session.TaskStartedAt, finished),
                TerminalKind.Antigravity => TaskUsage.ReadAntigravity(projectId, task.Id, session.TaskStartedAt, finished),
                _ => null,
            }
            : null;
        Log.Info($"Task {task.Id} completed by terminal session: {session?.Title ?? task.Title}" +
            (duration is { } d ? $" in {d:hh\\:mm\\:ss}" : "") +
            (tokens is { } t ? $", {t.Total} tokens ({t.Input} in, {t.Output} out, {t.CacheRead} cache read, {t.CacheCreation} cache write)" : "") +
            (session is not null ? $", model {session.Model ?? "default"}, effort {session.Effort ?? "default"}" : ""));
        if (session is not null) TaskCompleted?.Invoke(new TaskCompletion(session.Id, projectId, task.Id, task.Title, session.TaskStartedAt, duration, tokens, session.Model, session.Effort, session.Kind));
        return true;
    }

    /// <summary>
    /// Claude is still on a task in this project, or the user is working in its Terminal session.
    /// The next queued task waits then, so two sessions don't work in the folder at once.
    /// </summary>
    public bool IsBusy(long projectId) =>
        _sessions.Values.Any(s => s.ProjectId == projectId && s.Alive && (s.TaskRunning || (s.Used && !s.Background)));

    /// <summary>
    /// Makes a session the Terminal's session for its project again. An ended one shows its scrollback.
    /// The session it replaces moves to the background, unless nobody has used it: then there is nothing to keep.
    /// </summary>
    public TerminalInfo Reopen(string id)
    {
        var session = Get(id) ?? throw new ApiProblem(404, "session_gone", "That session is no longer available.");
        var others = _sessions.Values.Where(s => s.Id != id && s.ProjectId == session.ProjectId && !s.Background).ToList();
        foreach (var other in others)
        {
            if (other.Used) other.MoveToBackground();
            else Close(other.Id);
        }
        session.BringBack();
        return session.Info;
    }

    /// <summary>
    /// Same session mode: hands a task to the live session of its topic, as if the user typed the prompt. Claude reads it after
    /// its current turn, so this also works while Claude is still wrapping up its last task. Returns null if there is no such session.
    /// </summary>
    public async Task<TerminalSession?> ContinueAsync(long projectId, string projectName, string prompt, TaskDto task)
    {
        var session = _sessions.Values
            .Where(s => s.Alive && s.Kind == TerminalKind.Claude && s.ProjectId == projectId && s.TopicId == task.TopicId && !s.TaskRunning)
            .MaxBy(s => s.TaskStartedAt);
        if (session is null) return null;
        Reopen(session.Id);
        session.TakeTask(task, TaskSessionTitle("claude", projectName, task));
        session.Write(prompt);
        await Task.Delay(SubmitDelay);
        session.Write("\r");
        Log.Info($"Task {task.Id} continues in session: {session.Title}");
        return session;
    }

    private static string TaskSessionTitle(string cli, string projectName, TaskDto task) => $"{cli} · {projectName} · {task.Title}";

    /// <param name="model">Claude and Antigravity: the model to start on. Null leaves it to the CLI.</param>
    /// <param name="effort">Claude and Antigravity: the reasoning level to start on. Null leaves it to the CLI.</param>
    /// <param name="prompt">Claude and Antigravity: a first message to send. Must not contain user text (see TaskBriefs).</param>
    /// <param name="claudeSessionId">Claude only, with a prompt: the id for the new conversation, or the one to pick up with <paramref name="resume"/>.</param>
    public async Task<TerminalInfo> StartAsync(long projectId, string projectName, string folder, TerminalKind kind, int cols, int rows, string? prompt = null, TaskDto? task = null, string? claudeSessionId = null, bool resume = false, string? model = null, string? effort = null)
    {
        if (kind == TerminalKind.Shell) (model, effort) = (null, null);
        model = NormalizeModel(model);
        effort = NormalizeEffort(effort);
        string[] choiceArgs = [.. model is null ? [] : new[] { "--model", model }, .. effort is null ? [] : new[] { "--effort", effort }];
        string app;
        string[] args;
        var verbatim = false;
        string title;
        if (kind == TerminalKind.Claude)
        {
            var claude = _claude.Resolve() ?? throw new ApiProblem(503, "claude_missing",
                "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, or set \"claudePath\" in settings.json.");
            // .cmd shims (npm) have to go through cmd.exe. No permission-skipping flags: Claude asks before editing files.
            if (prompt is not null && (prompt.Contains('"') || prompt.Contains('%')))
                throw new ArgumentException("The prompt can't contain quotes or %");
            if (claudeSessionId is not null && !Guid.TryParse(claudeSessionId, out _))
                throw new ArgumentException("The Claude session id must be a UUID");
            string[] conversation = claudeSessionId is null ? [] : [resume ? "--resume" : "--session-id", claudeSessionId];
            if (claude.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
            {
                app = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                if (prompt is null)
                {
                    args = ["/d", "/c", claude, .. choiceArgs];
                }
                else
                {
                    // /s: cmd strips only the outer quotes, so both the shim path and the prompt stay quoted.
                    args = ["/d", "/s", "/c", $"\"\"{claude}\" {string.Join(' ', choiceArgs.Concat(conversation))} \"{prompt}\"\""];
                    verbatim = true;
                }
            }
            else
            {
                app = claude;
                args = prompt is null ? choiceArgs : [.. choiceArgs, .. conversation, prompt];
            }
            title = task is null ? $"claude · {projectName}" : TaskSessionTitle("claude", projectName, task);
        }
        else if (kind == TerminalKind.Antigravity)
        {
            // agy runs commands and edits files without asking, by the user's choice. Its CLI has no turbo mode, so this flag
            // is the closest match. Its ask and deny rules still apply. This is for agy only: claude keeps its prompts.
            string[] permissionArgs = ["--dangerously-skip-permissions"];
            app = _antigravity.Resolve() ?? throw new ApiProblem(503, "antigravity_missing",
                "Antigravity CLI not found. Install it, or set \"antigravityPath\" in settings.json.");
            List<string> extra = [];
            if (prompt is not null && _dataRoot is not null)
            {
                var workDir = Path.Combine(_dataRoot, "work");
                var contextDir = Path.Combine(_dataRoot, "context");
                Directory.CreateDirectory(workDir);
                Directory.CreateDirectory(contextDir);
                extra.AddRange(["--add-dir", workDir, "--add-dir", contextDir]);
                Log.Info($"Antigravity task workspace directories added: {workDir}, {contextDir}");
            }
            args = prompt is null ? [.. permissionArgs, .. choiceArgs] : [.. permissionArgs, .. choiceArgs, .. extra, "--prompt-interactive", prompt];
            title = task is null ? $"antigravity · {projectName}" : TaskSessionTitle("antigravity", projectName, task);
        }
        else
        {
            app = FindPowerShell();
            args = ["-NoLogo"];
            title = $"PowerShell · {projectName}";
        }

        var session = await TerminalSession.StartAsync(projectId, kind, folder, app, args, verbatim, title, cols, rows, _job, task, claudeSessionId, model, effort);
        _sessions[session.Id] = session;
        session.Persist = s => SessionChanged?.Invoke(s.Info, s.StartedAt);
        session.SaveNow();
        var others = _sessions.Values.Where(s => s.Id != session.Id && s.ProjectId == projectId && !s.Background).ToList();
        foreach (var other in others)
        {
            if (other.Used) other.MoveToBackground();
            else Close(other.Id);
        }
        RetireEnded(projectId);
        return session.Info;
    }

    /// <summary>
    /// The new session is now the Terminal's, so ended sessions of its project go to the background. Starting a session
    /// is the only way the list grows, so this is also where the oldest ended sessions are dropped.
    /// </summary>
    private void RetireEnded(long projectId)
    {
        foreach (var s in _sessions.Values.Where(s => s.ProjectId == projectId && !s.Alive)) s.MoveToBackground();
        var extra = _sessions.Values.Where(s => !s.Alive && s.Background).OrderByDescending(s => s.EndedAt).Skip(MaxEndedSessions).ToList();
        foreach (var s in extra) Remove(s.Id);
    }

    private static string FindPowerShell()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var pwsh = Path.Combine(dir.Trim(), "pwsh.exe");
                if (File.Exists(pwsh)) return pwsh;
            }
            catch
            {
            }
        }
        return Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
    }

    /// <summary>Ends a session. A used one stays listed for the session feed; one nobody touched has nothing to keep.</summary>
    public void Close(string id)
    {
        var session = Get(id);
        if (session is null) return;
        if (!session.Used)
        {
            Remove(id);
            return;
        }
        Log.Info($"Terminal closed: {session.Title}");
        session.Dispose();
        session.MoveToBackground();
    }

    private void Remove(string id)
    {
        if (_sessions.TryRemove(id, out var s))
        {
            Log.Info($"Terminal removed: {s.Title}");
            s.Dispose();
        }
    }

    public void CloseForProject(long projectId)
    {
        foreach (var s in _sessions.Values.Where(s => s.ProjectId == projectId).ToList()) Remove(s.Id);
    }

    public void Dispose()
    {
        foreach (var id in _sessions.Keys.ToList()) Remove(id);
    }
}
