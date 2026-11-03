using System.Diagnostics;
using System.Text;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace Bishop;

public record TranscriptionResult(string Text, string Backend, double AudioSeconds, long ElapsedMs, long LoadMs);

/// <summary>
/// Local speech-to-text with Whisper.net. Prefers CUDA, then Vulkan, then CPU.
/// The model file is downloaded on demand and loaded once, then reused.
/// </summary>
public sealed class Transcriber
{
    private const string ModelBaseUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

    private readonly string _modelName;
    private readonly string _modelPath;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _downloadLock = new();
    private WhisperFactory? _factory;

    private string? _backend;
    private string? _runtimeInfo;
    private Task? _download;
    private long _downloadedBytes;
    private long? _totalBytes;
    private string? _downloadError;

    public Transcriber(string modelName, string modelPath)
    {
        _modelName = modelName;
        _modelPath = modelPath;
        AddCudaToSearchPath();
    }

    /// <summary>
    /// The CUDA runtime needs cuBLAS 13 from the CUDA Toolkit. Make it findable
    /// even if PATH wasn't refreshed since the toolkit was installed.
    /// </summary>
    private static void AddCudaToSearchPath()
    {
        var cudaPath = Environment.GetEnvironmentVariable("CUDA_PATH");
        var dirs = new List<string>();
        if (!string.IsNullOrEmpty(cudaPath))
        {
            dirs.Add(Path.Combine(cudaPath, "bin", "x64"));
            dirs.Add(Path.Combine(cudaPath, "bin"));
        }
        var toolkitRoot = @"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA";
        if (Directory.Exists(toolkitRoot))
        {
            foreach (var v in Directory.GetDirectories(toolkitRoot, "v13*").OrderDescending())
            {
                dirs.Add(Path.Combine(v, "bin", "x64"));
                dirs.Add(Path.Combine(v, "bin"));
            }
        }
        var existing = dirs.Where(d => File.Exists(Path.Combine(d, "cublas64_13.dll"))).ToList();
        if (existing.Count > 0)
        {
            Environment.SetEnvironmentVariable("PATH", string.Join(';', existing) + ";" + Environment.GetEnvironmentVariable("PATH"));
        }
    }

    public bool ModelPresent => File.Exists(_modelPath);

    public object Status()
    {
        string state;
        if (_download is { IsCompleted: false }) state = "downloading";
        else if (_downloadError is not null && !ModelPresent) state = "error";
        else if (!ModelPresent) state = "missing";
        else state = _factory is null ? "ready" : "loaded";

        return new
        {
            model = _modelName,
            modelPath = _modelPath,
            state,
            downloadedBytes = Interlocked.Read(ref _downloadedBytes),
            totalBytes = _totalBytes,
            error = _downloadError,
            backend = _backend,
            runtimeInfo = _runtimeInfo,
        };
    }

    /// <summary>Starts the model download in the background (no-op if present or in progress).</summary>
    public void StartDownload()
    {
        lock (_downloadLock)
        {
            if (ModelPresent || _download is { IsCompleted: false }) return;
            _downloadError = null;
            _downloadedBytes = 0;
            _totalBytes = null;
            _download = Task.Run(DownloadAsync);
        }
    }

    private async Task DownloadAsync()
    {
        var url = $"{ModelBaseUrl}ggml-{_modelName}.bin";
        var partPath = _modelPath + ".part";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_modelPath)!);
            Log.Info($"Downloading Whisper model {url} -> {_modelPath}");
            var sw = Stopwatch.StartNew();
            using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
            using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();
            _totalBytes = resp.Content.Headers.ContentLength;

            await using (var src = await resp.Content.ReadAsStreamAsync())
            await using (var dst = File.Create(partPath))
            {
                var buffer = new byte[1 << 20];
                int read;
                while ((read = await src.ReadAsync(buffer)) > 0)
                {
                    await dst.WriteAsync(buffer.AsMemory(0, read));
                    Interlocked.Add(ref _downloadedBytes, read);
                }
            }
            if (_totalBytes is { } total && new FileInfo(partPath).Length != total)
                throw new IOException("Download incomplete");
            File.Move(partPath, _modelPath, overwrite: true);
            Log.Info($"Model download finished in {sw.Elapsed.TotalSeconds:F1}s ({_downloadedBytes / 1048576} MB)");
        }
        catch (Exception ex)
        {
            _downloadError = $"Model download failed: {ex.Message}";
            Log.Info(_downloadError);
            try { File.Delete(partPath); } catch { }
        }
    }

    private WhisperFactory LoadFactory()
    {
        RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Cuda, RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu];
        var factory = WhisperFactory.FromPath(_modelPath, new WhisperFactoryOptions { UseGpu = true, UseFlashAttention = true });
        _backend = RuntimeOptions.LoadedLibrary?.ToString() ?? "unknown";
        try { _runtimeInfo = WhisperFactory.GetRuntimeInfo(); } catch { }
        Log.Info($"Whisper model loaded: {_modelPath}; backend={_backend}; runtime={_runtimeInfo}");
        return factory;
    }

    /// <param name="wav">16 kHz mono 16-bit PCM WAV.</param>
    public async Task<TranscriptionResult> TranscribeAsync(Stream wav, CancellationToken ct)
    {
        if (!ModelPresent)
            throw new ApiProblem(409, "model_missing", $"Whisper model not downloaded yet ({_modelName}).");

        await _gate.WaitAsync(ct);
        try
        {
            long loadMs = 0;
            if (_factory is null)
            {
                var loadSw = Stopwatch.StartNew();
                try
                {
                    _factory = LoadFactory();
                }
                catch (Exception ex)
                {
                    Log.Info($"Whisper load failed: {ex}");
                    throw new ApiProblem(500, "model_load_failed", $"Couldn't load the Whisper model: {ex.Message}");
                }
                loadMs = loadSw.ElapsedMilliseconds;
            }

            var audioSeconds = Math.Max(0, (wav.Length - 44) / (16000.0 * 2));
            var sw = Stopwatch.StartNew();
            using var processor = _factory.CreateBuilder().WithLanguage("auto").Build();
            var text = new StringBuilder();
            await foreach (var segment in processor.ProcessAsync(wav, ct))
            {
                text.Append(segment.Text);
            }
            sw.Stop();
            var result = new TranscriptionResult(text.ToString().Trim(), _backend ?? "unknown", Math.Round(audioSeconds, 2), sw.ElapsedMilliseconds, loadMs);
            Log.Info($"Transcribed {result.AudioSeconds}s audio in {result.ElapsedMs}ms (load {loadMs}ms) on {result.Backend}");
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
}
