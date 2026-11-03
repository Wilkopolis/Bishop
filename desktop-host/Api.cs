using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Bishop;

/// <summary>Minimal JSON API over <see cref="Storage"/>, plus frameless-window controls.</summary>
public static class Api
{
    public static void MapBishopApi(this WebApplication app, Storage storage, Backups backups, Transcriber transcriber, ClaudeCli claude, Func<BishopWindow?> window)
    {
        // Map storage exceptions to HTTP status codes.
        app.Use(async (ctx, next) =>
        {
            try
            {
                await next(ctx);
            }
            catch (ApiProblem ex)
            {
                await WriteError(ctx, ex.Status, ex.Message, ex.Code);
            }
            catch (NotFoundException ex)
            {
                await WriteError(ctx, StatusCodes.Status404NotFound, ex.Message);
            }
            catch (Exception ex) when (ex is ArgumentException or JsonException or BadHttpRequestException)
            {
                await WriteError(ctx, StatusCodes.Status400BadRequest, ex.Message);
            }
        });

        var api = app.MapGroup("/api");

        api.MapGet("/health", () => new { ok = true, dataRoot = storage.DataRoot });

        // ---- tree: folders + projects
        api.MapGet("/tree", () => storage.GetTree());

        api.MapPost("/folders", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.CreateFolder(body.String("name") ?? "", body.Long("parentId").Value);
        });
        api.MapPatch("/folders/{id:long}", async (long id, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.UpdateFolder(id, body.String("name"), body.Long("parentId"));
        });
        api.MapDelete("/folders/{id:long}", (long id) =>
        {
            storage.DeleteFolder(id);
            return Results.NoContent();
        });

        api.MapPost("/projects", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.CreateProject(body.String("name") ?? "", body.Long("folderId").Value, body.String("tagline"));
        });
        api.MapPatch("/projects/{id:long}", async (long id, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.UpdateProject(id, body.String("name"), body.Long("folderId"), body.OptionalString("tagline"));
        });
        // Drag and drop: place projects, in order, into a folder (null = root).
        api.MapPost("/projects/reorder", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.ReorderProjects(body.Long("folderId").Value, body.LongArray("projectIds"));
        });
        api.MapDelete("/projects/{id:long}", (long id) =>
        {
            storage.DeleteProject(id);
            return Results.NoContent();
        });

        // ---- topics (each returned with its tasks)
        api.MapGet("/projects/{pid:long}/topics", (long pid) => storage.ListTopics(pid));
        api.MapPost("/projects/{pid:long}/topics", async (long pid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.CreateTopic(pid, body.String("title") ?? "", body.String("description"), body.String("category"));
        });
        // Drag and drop: the full ordered list of topics for one category column.
        api.MapPost("/projects/{pid:long}/topics/reorder", async (long pid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.ReorderTopics(pid, body.String("category") ?? "", body.LongArray("topicIds"));
        });
        api.MapPatch("/projects/{pid:long}/topics/{tid:long}", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.UpdateTopic(pid, tid, body.String("title"), body.String("description"),
                body.String("category"), body.Long("sortOrder").Value);
        });
        api.MapDelete("/projects/{pid:long}/topics/{tid:long}", (long pid, long tid) =>
        {
            storage.DeleteTopic(pid, tid);
            return Results.NoContent();
        });

        // ---- tasks
        api.MapGet("/projects/{pid:long}/topics/{tid:long}/tasks", (long pid, long tid) => storage.ListTasks(pid, tid));
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/tasks", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.AddTask(pid, tid, body.String("title") ?? "");
        });
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/tasks/reorder", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.ReorderTasks(pid, tid, body.LongArray("taskIds"));
        });
        api.MapPatch("/projects/{pid:long}/tasks/{taskId:long}", async (long pid, long taskId, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.UpdateTask(pid, taskId, body.String("title"), body.Bool("completed"), body.Long("sortOrder").Value);
        });
        api.MapDelete("/projects/{pid:long}/tasks/{taskId:long}", (long pid, long taskId) =>
        {
            storage.DeleteTask(pid, taskId);
            return Results.NoContent();
        });

        // ---- search across all projects
        api.MapGet("/search", (string? q) => storage.Search(q ?? ""));

        // ---- backups
        api.MapGet("/backups", () => new { folder = backups.Root, keep = Backups.Keep, backups = backups.List() });
        api.MapPost("/backups", () => backups.BackupNow());
        api.MapPost("/backups/open", () =>
        {
            Directory.CreateDirectory(backups.Root);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = backups.Root, UseShellExecute = true });
            return Results.Json(new { ok = true });
        });

        // ---- voice: local Whisper transcription + Claude CLI topic drafting
        api.MapGet("/voice/status", () => VoiceStatus(transcriber, claude));
        api.MapPost("/voice/model/download", () =>
        {
            transcriber.StartDownload();
            return VoiceStatus(transcriber, claude);
        });

        // Body: 16 kHz mono 16-bit PCM WAV.
        api.MapPost("/transcribe", async (HttpContext ctx) =>
        {
            var sizeFeature = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = 200L * 1024 * 1024;
            using var wav = new MemoryStream();
            await ctx.Request.Body.CopyToAsync(wav, ctx.RequestAborted);
            if (wav.Length <= 44) throw new ArgumentException("No audio received");
            wav.Position = 0;
            return await transcriber.TranscribeAsync(wav, ctx.RequestAborted);
        });

        api.MapPost("/projects/{pid:long}/topic-from-transcript", async (long pid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var transcript = body.String("transcript")?.Trim();
            if (string.IsNullOrEmpty(transcript)) throw new ArgumentException("Transcript is empty");
            var project = storage.GetProject(pid);
            return await claude.TopicFromTranscriptAsync(project.Name, transcript, ctx.RequestAborted);
        });

        // ---- frameless window controls (no-ops when running --api-only)
        api.MapPost("/window/{action}", async (string action, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var win = window();
            switch (action)
            {
                case "drag": win?.DragWindow(); break;
                case "resize": win?.ResizeWindow(body.String("dir") ?? "bottomRight"); break;
                case "minimize": win?.MinimizeWindow(); break;
                case "maximize": return Results.Json(new { ok = true, isMaximized = win?.ToggleMaximizeWindow() ?? false });
                case "close":
                    Log.Info($"Close requested via /api/window/close from {ctx.Request.Headers.UserAgent}");
                    win?.CloseWindow();
                    break;
                default: return Results.NotFound();
            }
            return Results.Json(new { ok = true });
        });
    }

    private static object VoiceStatus(Transcriber transcriber, ClaudeCli claude)
    {
        var claudePath = claude.Resolve();
        return new { whisper = transcriber.Status(), claude = new { found = claudePath is not null, path = claudePath } };
    }

    private static async Task WriteError(HttpContext ctx, int status, string message, string? code = null)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error = message, code });
    }

    private static async Task<Body> ReadBody(HttpContext ctx)
    {
        if (ctx.Request.ContentLength is 0 or null && !ctx.Request.Headers.TransferEncoding.Any())
            return new Body(default);
        using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
        return new Body(doc.RootElement.Clone());
    }

    /// <summary>Loose accessor over a JSON object body.</summary>
    private readonly record struct Body(JsonElement Root)
    {
        private bool TryGet(string name, out JsonElement el)
        {
            el = default;
            return Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(name, out el);
        }

        public string? String(string name) =>
            TryGet(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

        public bool? Bool(string name) =>
            TryGet(name, out var el) && el.ValueKind is JsonValueKind.True or JsonValueKind.False ? el.GetBoolean() : null;

        public List<long> LongArray(string name)
        {
            if (!TryGet(name, out var el) || el.ValueKind != JsonValueKind.Array)
                throw new ArgumentException($"'{name}' must be an array of ids");
            var list = new List<long>();
            foreach (var item in el.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var n))
                    throw new ArgumentException($"'{name}' must contain only integer ids");
                list.Add(n);
            }
            if (list.Distinct().Count() != list.Count) throw new ArgumentException($"'{name}' contains duplicates");
            return list;
        }

        /// <summary>None if absent; Some(null) if explicitly null; Some(s) for a string.</summary>
        public Optional<string?> OptionalString(string name)
        {
            if (!TryGet(name, out var el)) return Optional<string?>.None;
            if (el.ValueKind == JsonValueKind.Null) return Optional<string?>.Some(null);
            if (el.ValueKind == JsonValueKind.String) return Optional<string?>.Some(el.GetString());
            throw new ArgumentException($"'{name}' must be a string or null");
        }

        /// <summary>None if absent; Some(null) if explicitly null; Some(n) for a number.</summary>
        public Optional<long?> Long(string name)
        {
            if (!TryGet(name, out var el)) return Optional<long?>.None;
            if (el.ValueKind == JsonValueKind.Null) return Optional<long?>.Some(null);
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var n)) return Optional<long?>.Some(n);
            throw new ArgumentException($"'{name}' must be an integer or null");
        }
    }
}
