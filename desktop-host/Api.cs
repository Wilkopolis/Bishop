using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Bishop;

/// <summary>Minimal JSON API over <see cref="Storage"/>, plus frameless-window controls.</summary>
public static class Api
{
    public static void MapBishopApi(this WebApplication app, Storage storage, Backups backups, Transcriber transcriber, ClaudeCli claude, AppSettings settings, Terminals terminals, Func<BishopWindow?> window)
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

        // A project always gets a working folder on disk (created if missing, AGENTS.md added if missing).
        api.MapPost("/projects", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var name = body.String("name")?.Trim() ?? "";
            if (name.Length == 0) throw new ArgumentException("Project name is required");
            var folderPath = ProjectFolders.Normalize(body.String("folderPath"));
            var tagline = body.String("tagline");
            ProjectFolders.Link(folderPath, name, tagline);
            return storage.CreateProject(name, body.Long("folderId").Value, tagline, folderPath);
        });
        api.MapPatch("/projects/{id:long}", async (long id, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            // folderPath relinks the project (no files are moved); AGENTS.md is added there if missing.
            string? folderPath = null;
            if (body.OptionalString("folderPath") is { HasValue: true } fp)
            {
                folderPath = ProjectFolders.Normalize(fp.Value);
                var current = storage.GetProject(id);
                ProjectFolders.Link(folderPath, body.String("name") ?? current.Name, current.Tagline);
            }
            return storage.UpdateProject(id, body.String("name"), body.Long("folderId"), body.OptionalString("tagline"), folderPath);
        });

        // ---- terminal: claude (or PowerShell) in a pseudo-console, streamed over a WebSocket
        api.MapGet("/terminal/sessions", (long? projectId) => terminals.List(projectId));
        api.MapPost("/terminal/sessions", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var projectId = body.Long("projectId").Value ?? throw new ArgumentException("projectId is required");
            var project = storage.GetProject(projectId);
            var folder = RequireFolder(storage, projectId);
            var kind = body.String("kind") == "shell" ? TerminalKind.Shell : TerminalKind.Claude;
            var cols = (int)(body.Long("cols").Value ?? 100);
            var rows = (int)(body.Long("rows").Value ?? 30);
            return await terminals.StartAsync(projectId, project.Name, folder, kind, cols, rows);
        });
        api.MapDelete("/terminal/sessions/{id}", (string id) =>
        {
            terminals.Close(id);
            return Results.NoContent();
        });
        api.Map("/terminal/ws/{id}", async (string id, HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 400;
                return;
            }
            // Only Bishop's own pages (loopback origins) may attach to a terminal.
            if (!IsLocalOrigin(ctx))
            {
                Log.Info($"Rejected terminal WebSocket from origin '{ctx.Request.Headers.Origin}'");
                ctx.Response.StatusCode = 403;
                return;
            }
            var session = terminals.Get(id);
            if (session is null)
            {
                ctx.Response.StatusCode = 404;
                return;
            }
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            await session.AttachAsync(socket, ctx.RequestAborted);
        });

        // ---- project working folders
        api.MapGet("/project-folders/suggest", (string? name) =>
            new { root = settings.ProjectsRoot, path = ProjectFolders.Suggest(settings.ProjectsRoot, name) });
        api.MapGet("/project-folders/status", (string? path) => ProjectFolders.Status(ProjectFolders.Normalize(path)));
        api.MapPost("/system/pick-folder", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var initial = body.String("initial");
            var title = body.String("title");
            var win = window();
            if (win is not null) return Results.Json(new { path = win.PickFolder(initial, title) });

            // --api-only (dev): no window to own the dialog; show it on its own STA thread.
            string? picked = null;
            var thread = new Thread(() => picked = BishopWindow.ShowFolderDialog(null, initial, title));
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            return Results.Json(new { path = picked });
        });
        api.MapPost("/projects/{id:long}/open-folder", (long id) =>
        {
            var p = storage.GetProject(id);
            if (p.FolderPath is null || !Directory.Exists(p.FolderPath))
                throw new ApiProblem(409, "folder_missing", "The project folder isn't linked or no longer exists.");
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = p.FolderPath, UseShellExecute = true });
            return Results.Json(new { ok = true });
        });
        api.MapGet("/projects/{id:long}/agents", (long id) => ProjectFolders.ReadAgents(RequireFolder(storage, id)));
        api.MapPut("/projects/{id:long}/agents", async (long id, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return ProjectFolders.WriteAgents(RequireFolder(storage, id), body.String("content") ?? "", body.String("baseHash"), body.Bool("force") ?? false);
        });
        // Drag and drop: place projects, in order, into a folder (null = root).
        api.MapPost("/projects/reorder", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.ReorderProjects(body.Long("folderId").Value, body.LongArray("projectIds"));
        });
        api.MapDelete("/projects/{id:long}", (long id) =>
        {
            terminals.CloseForProject(id);
            storage.DeleteProject(id);
            return Results.NoContent();
        });

        // ---- project picture (raw image body; see ProjectImages for limits)
        api.MapGet("/projects/{id:long}/image", (long id, HttpContext ctx) =>
        {
            var image = storage.GetProjectImage(id);
            // URLs carry ?v=<image_version>, so the bytes behind one URL never change.
            ctx.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            return Results.Bytes(image.Data, image.Mime);
        });
        api.MapPost("/projects/{id:long}/image", async (long id, HttpContext ctx) =>
        {
            var sizeFeature = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = ProjectImages.MaxUploadBytes + 1;
            using var body = new MemoryStream();
            try
            {
                await ctx.Request.Body.CopyToAsync(body, ctx.RequestAborted);
            }
            catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
            {
                throw new ApiProblem(413, "too_large", $"Picture is too large; the limit is {ProjectImages.MaxUploadBytes / 1048576} MB");
            }
            storage.GetProject(id); // 404 before doing any image work
            return storage.SetProjectImage(id, ProjectImages.Prepare(body.ToArray()));
        });
        api.MapDelete("/projects/{id:long}/image", (long id) => storage.DeleteProjectImage(id));

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
            // Run Claude in the project folder (it reads AGENTS.md there) and give it the existing topics.
            var workDir = project.FolderPath is { } f && Directory.Exists(f) ? f : null;
            var existing = storage.ListTopics(pid)
                .GroupBy(t => t.Category)
                .ToDictionary(g => g.Key, g => g.Select(t => t.Title).ToList());
            return await claude.TopicFromTranscriptAsync(project.Name, project.Tagline, existing, transcript, workDir, ctx.RequestAborted);
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

    private static bool IsLocalOrigin(HttpContext ctx)
    {
        if (ctx.Connection.RemoteIpAddress is { } ip && !System.Net.IPAddress.IsLoopback(ip)) return false;
        var origin = ctx.Request.Headers.Origin.ToString();
        if (string.IsNullOrEmpty(origin)) return false;
        return Uri.TryCreate(origin, UriKind.Absolute, out var uri)
            && uri.Scheme == "http"
            && (uri.Host == "127.0.0.1" || uri.Host == "localhost");
    }

    private static string RequireFolder(Storage storage, long projectId)
    {
        var p = storage.GetProject(projectId);
        if (p.FolderPath is null) throw new ApiProblem(409, "folder_unlinked", "This project has no folder yet.");
        if (!Directory.Exists(p.FolderPath)) throw new ApiProblem(409, "folder_missing", $"The project folder doesn't exist: {p.FolderPath}");
        return p.FolderPath;
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
