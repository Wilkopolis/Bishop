using System.Collections.Concurrent;
using System.ComponentModel;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
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

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
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
        if (h == IntPtr.Zero) return;
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

public enum TerminalKind { Claude, Shell }

public record TerminalInfo(string Id, long ProjectId, string Kind, string Title, string Cwd, bool Alive, int? ExitCode);

/// <summary>One pseudo-terminal running claude (or a shell) in a project folder.</summary>
public sealed class TerminalSession : IDisposable
{
    private const int MaxScrollback = 512 * 1024;

    private readonly IPtyConnection _pty;
    private readonly StringBuilder _scrollback = new();
    private readonly object _gate = new();
    private readonly Decoder _decoder = new UTF8Encoding(false).GetDecoder();
    private WebSocket? _socket;
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long ProjectId { get; }
    public TerminalKind Kind { get; }
    public string Title { get; }
    public string Cwd { get; }
    public bool Alive { get; private set; } = true;
    public int? ExitCode { get; private set; }

    private TerminalSession(IPtyConnection pty, long projectId, TerminalKind kind, string title, string cwd)
    {
        _pty = pty;
        ProjectId = projectId;
        Kind = kind;
        Title = title;
        Cwd = cwd;
        _pty.ProcessExited += (_, e) =>
        {
            Alive = false;
            ExitCode = e.ExitCode;
            _ = SendJsonAsync(new { type = "exit", code = e.ExitCode });
        };
        _ = Task.Run(ReadLoopAsync);
    }

    public TerminalInfo Info => new(Id, ProjectId, Kind == TerminalKind.Claude ? "claude" : "shell", Title, Cwd, Alive, ExitCode);

    public static async Task<TerminalSession> StartAsync(long projectId, TerminalKind kind, string cwd, string app, string[] args, string title, int cols, int rows, KillOnCloseJob? job)
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
            Cwd = cwd,
            Cols = Math.Clamp(cols, 20, 500),
            Rows = Math.Clamp(rows, 5, 200),
            Environment = env,
        };
        var pty = await PtyProvider.SpawnAsync(options, CancellationToken.None);
        job?.Add(pty.Pid);
        Log.Info($"Terminal started: {title} (pid {pty.Pid}) in {cwd}");
        return new TerminalSession(pty, projectId, kind, title, cwd);
    }

    private async Task ReadLoopAsync()
    {
        var buffer = new byte[16 * 1024];
        var chars = new char[buffer.Length + 8];
        try
        {
            while (true)
            {
                var n = await _pty.ReaderStream.ReadAsync(buffer);
                if (n <= 0) break;
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
        Alive = false;
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
                    Write(root.GetProperty("data").GetString() ?? "");
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

    public void Dispose()
    {
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
        Alive = false;
    }
}

/// <summary>All terminal sessions, keyed by id. One "current" session per project is tracked by the UI.</summary>
public sealed class Terminals : IDisposable
{
    private readonly ConcurrentDictionary<string, TerminalSession> _sessions = new();
    private readonly ClaudeCli _claude;
    private readonly KillOnCloseJob? _job;

    public Terminals(ClaudeCli claude)
    {
        _claude = claude;
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

    public async Task<TerminalInfo> StartAsync(long projectId, string projectName, string folder, TerminalKind kind, int cols, int rows)
    {
        string app;
        string[] args;
        string title;
        if (kind == TerminalKind.Claude)
        {
            var claude = _claude.Resolve() ?? throw new ApiProblem(503, "claude_missing",
                "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, or set \"claudePath\" in settings.json.");
            // .cmd shims (npm) have to go through cmd.exe. No permission-skipping flags: Claude asks before editing files.
            if (claude.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
            {
                app = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                args = ["/d", "/c", claude];
            }
            else
            {
                app = claude;
                args = [];
            }
            title = $"claude · {projectName}";
        }
        else
        {
            app = FindPowerShell();
            args = ["-NoLogo"];
            title = $"PowerShell · {projectName}";
        }

        var session = await TerminalSession.StartAsync(projectId, kind, folder, app, args, title, cols, rows, _job);
        _sessions[session.Id] = session;
        return session.Info;
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

    public void Close(string id)
    {
        if (_sessions.TryRemove(id, out var s))
        {
            Log.Info($"Terminal closed: {s.Title}");
            s.Dispose();
        }
    }

    public void CloseForProject(long projectId)
    {
        foreach (var s in _sessions.Values.Where(s => s.ProjectId == projectId).ToList()) Close(s.Id);
    }

    public void Dispose()
    {
        foreach (var id in _sessions.Keys.ToList()) Close(id);
    }
}
