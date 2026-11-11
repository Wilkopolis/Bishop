using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Bishop;

/// <summary>Minimal JSON API over <see cref="Storage"/>, plus frameless-window controls.</summary>
public static class Api
{
    public static void MapBishopApi(this WebApplication app, Storage storage, Backups backups, Transcriber transcriber, ClaudeCli claude, AppSettings settings, Terminals terminals, Func<BishopWindow?> window)
    {
        // Map storage exceptions to HTTP status codes.
        // Also logs the API trail: changes (non-GET) and every failure. Plain reads are not logged.
        app.Use(async (ctx, next) =>
        {
            var path = ctx.Request.Path.Value ?? "";
            var isApi = path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
                && !path.Equals("/api/log", StringComparison.OrdinalIgnoreCase)
                && !path.StartsWith("/api/health", StringComparison.OrdinalIgnoreCase);
            var isRead = HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            string? failure = null;
            try
            {
                await next(ctx);
            }
            catch (ApiProblem ex)
            {
                failure = $"{ex.Code}: {ex.Message}";
                await WriteError(ctx, ex.Status, ex.Message, ex.Code);
            }
            catch (NotFoundException ex)
            {
                failure = ex.Message;
                await WriteError(ctx, StatusCodes.Status404NotFound, ex.Message);
            }
            catch (Exception ex) when (ex is ArgumentException or JsonException or BadHttpRequestException)
            {
                failure = ex.Message;
                await WriteError(ctx, StatusCodes.Status400BadRequest, ex.Message);
            }
            catch (Exception ex)
            {
                Log.Error($"{ctx.Request.Method} {path}{ctx.Request.QueryString} crashed", ex, "api");
                await WriteError(ctx, StatusCodes.Status500InternalServerError, "Something went wrong in Bishop. The details are in the log.");
                return;
            }
            if (!isApi) return;
            var status = ctx.Response.StatusCode;
            var line = $"{ctx.Request.Method} {path} -> {status} ({sw.ElapsedMilliseconds} ms)" + (failure is null ? "" : $": {failure}");
            if (status >= 500) Log.Error(line, null, "api");
            else if (status >= 400) Log.Warn(line, "api");
            else if (!isRead) Log.Info(line, "api");
        });

        var api = app.MapGroup("/api");

        // The UI reports its errors, failed requests and clicks here. Always 204, never an error.
        api.MapPost("/log", async (HttpContext ctx) =>
        {
            try
            {
                using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
                var entries = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().Take(50) : [doc.RootElement];
                foreach (var e in entries)
                {
                    if (e.ValueKind != JsonValueKind.Object) continue;
                    string? Str(string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                    var message = Str("message");
                    if (string.IsNullOrWhiteSpace(message)) continue;
                    var stack = Str("stack");
                    Log.FromText(Str("level"), "ui", stack is null ? message : $"{message}\n{stack}");
                }
            }
            catch { }
            return Results.NoContent();
        });

        api.MapGet("/health", () => new { ok = true, dataRoot = storage.DataRoot });

        // ---- tree: folders + projects
        api.MapGet("/tree", () => storage.GetTree());
        api.MapGet("/queued-tasks", () => storage.QueuedCounts());
        api.MapGet("/task-metrics", () => storage.ListTaskMetrics());

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
            return storage.CreateProject(name, body.Long("folderId").Value, tagline, folderPath, body.String("displayType"));
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
            return storage.UpdateProject(id, body.String("name"), body.Long("folderId"), body.OptionalString("tagline"), folderPath,
                body.OptionalString("icon"), body.OptionalString("iconColor"),
                body.OptionalString("claudeModel"), body.OptionalString("claudeEffort"),
                body.OptionalString("antigravityModel"), body.OptionalString("antigravityEffort"), body.OptionalString("aiService"), body.String("displayType"));
        });

        // ---- terminal: claude, agy or PowerShell in a pseudo-console, streamed over a WebSocket
        api.MapGet("/terminal/sessions", (long? projectId) => terminals.List(projectId));
        // Saved sessions of a project from this run that were active in the past `days` days (default 7, 1 to 90), most recent activity first.
        api.MapGet("/projects/{pid:long}/sessions", (long pid, int? days) =>
            storage.ListRecentSessions(pid, Math.Clamp(days ?? 7, 1, 90)));
        api.MapGet("/terminal/models", async (string? kind, CancellationToken ct) => kind switch
        {
            "claude" => ClaudeCli.TerminalModels.ToList(),
            "antigravity" => await terminals.AntigravityModelsAsync(ct),
            _ => [],
        });
        api.MapPost("/terminal/sessions", async (HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var projectId = body.Long("projectId").Value ?? throw new ArgumentException("projectId is required");
            var project = storage.GetProject(projectId);
            var folder = RequireFolder(storage, projectId);
            var kind = body.String("kind") switch
            {
                "shell" => TerminalKind.Shell,
                "antigravity" => TerminalKind.Antigravity,
                _ => TerminalKind.Claude,
            };
            var cols = (int)(body.Long("cols").Value ?? 100);
            var rows = (int)(body.Long("rows").Value ?? 30);
            var model = body.String("model") is { Length: > 0 } m ? m : null;
            var effort = body.String("effort") is { Length: > 0 } e ? e : null;
            // taskId: start Claude or Antigravity on one task, with a brief about its topic (see TaskBriefs).
            if (body.Long("taskId").Value is { } taskId)
            {
                if (kind == TerminalKind.Shell) throw new ArgumentException("taskId needs kind \"claude\" or \"antigravity\"");
                var topic = storage.ListTopics(projectId).FirstOrDefault(t => t.Tasks.Any(k => k.Id == taskId))
                    ?? throw new NotFoundException($"Task {taskId} not found");
                var task = topic.Tasks.First(k => k.Id == taskId);
                return await StartTaskSession(storage, terminals, project, folder, topic, task, ctx.Connection.LocalPort, cols, rows, kind, model, effort);
            }
            return await terminals.StartAsync(projectId, project.Name, folder, kind, cols, rows, model: model, effort: effort);
        });
        api.MapGet("/terminal/antigravity-trust", (long projectId) => new { trusted = terminals.AntigravityTrusts(RequireFolder(storage, projectId)) });
        // Grants agy access to a folder, so only Bishop's own pages may call it, after the user agreed.
        api.MapPost("/terminal/antigravity-trust", async (HttpContext ctx) =>
        {
            if (!IsLocalOrigin(ctx)) return Results.StatusCode(403);
            var body = await ReadBody(ctx);
            var projectId = body.Long("projectId").Value ?? throw new ArgumentException("projectId is required");
            terminals.TrustForAntigravity(RequireFolder(storage, projectId));
            return Results.NoContent();
        });
        api.MapPost("/terminal/sessions/{id}/reopen", (string id) => terminals.Reopen(id));
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

        // ---- categories (each project has its own list)
        api.MapGet("/projects/{pid:long}/categories", (long pid) => storage.GetCategories(pid));
        api.MapPost("/projects/{pid:long}/categories", async (long pid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.AddCategory(pid, body.String("name"));
        });
        api.MapPatch("/projects/{pid:long}/categories/{category}", async (long pid, string category, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.RenameCategory(pid, category, body.String("name"));
        });
        api.MapDelete("/projects/{pid:long}/categories/{category}", (long pid, string category, string? moveTo) =>
            storage.RemoveCategory(pid, category, moveTo));

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
                body.String("category"), body.Long("sortOrder").Value, body.Bool("archived"), body.Bool("sameSession"), body.String("modelFamily"),
                body.OptionalString("modelOverride"), body.OptionalString("effortOverride"));
        });
        // Moves a topic and its tasks to another project. Body: { toProjectId, category? }. Returns the moved topic (new ids).
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/move", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var to = body.Long("toProjectId").Value ?? throw new ArgumentException("toProjectId is required");
            return storage.MoveTopic(pid, tid, to, body.String("category"));
        });
        api.MapDelete("/projects/{pid:long}/topics/{tid:long}", (long pid, long tid) =>
        {
            storage.DeleteTopic(pid, tid);
            return Results.NoContent();
        });

        // The topic's context file: what Claude did on its finished tasks (see TopicContext).
        api.MapGet("/projects/{pid:long}/topics/{tid:long}/context", (long pid, long tid) =>
        {
            storage.ListTasks(pid, tid); // 404 for an unknown project or topic
            return TopicContext.Read(storage.DataRoot, pid, tid);
        });

        // Reviews a topic's title, description and tasks for missing details.
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/review", async (long pid, long tid, HttpContext ctx) =>
        {
            var project = storage.GetProject(pid);
            var topic = storage.GetTopic(pid, tid);
            var tasks = storage.ListTasks(pid, tid);

            string title = topic.Title;
            string description = topic.Description ?? "";
            string category = topic.Category;
            List<string> taskTitles = tasks.Select(t => t.Title).ToList();
            List<string> clarifications = [];

            if (ctx.Request.ContentLength is > 0)
            {
                var body = await ReadBody(ctx);
                if (body.String("title")?.Trim() is { Length: > 0 } customTitle) title = customTitle;
                if (body.String("description") is { } customDesc) description = customDesc.Trim();
                if (body.String("category") is { } customCat) category = customCat;
                if (body.StringArray("tasks") is { } customTasks && customTasks.Count > 0) taskTitles = customTasks;
                if (body.StringArray("answers") is { } ans) clarifications.AddRange(ans);
                if (body.String("notes")?.Trim() is { Length: > 0 } notes) clarifications.Add(notes);
            }

            var draft = new TopicDraft(title, description, category, taskTitles);
            return await claude.ReviewTopicAsync(project.Name, project.Tagline, ExistingTopics(storage, pid, tid), draft, ClaudeWorkDir(project.FolderPath), clarifications, ctx.RequestAborted);
        });

        // Updates a topic's title, description and tasks incorporating user answers to clarifying questions.
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/refine", async (long pid, long tid, HttpContext ctx) =>
        {
            var project = storage.GetProject(pid);
            var topic = storage.GetTopic(pid, tid);
            var tasks = storage.ListTasks(pid, tid);

            string title = topic.Title;
            string description = topic.Description ?? "";
            string category = topic.Category;
            List<string> taskTitles = tasks.Select(t => t.Title).ToList();
            List<string> clarifications = [];
            List<string> missingItems = [];

            if (ctx.Request.ContentLength is > 0)
            {
                var body = await ReadBody(ctx);
                if (body.String("title")?.Trim() is { Length: > 0 } customTitle) title = customTitle;
                if (body.String("description") is { } customDesc) description = customDesc.Trim();
                if (body.String("category") is { } customCat) category = customCat;
                if (body.StringArray("tasks") is { } customTasks && customTasks.Count > 0) taskTitles = customTasks;
                if (body.StringArray("answers") is { } ans) clarifications.AddRange(ans);
                if (body.String("notes")?.Trim() is { Length: > 0 } notes) clarifications.Add(notes);
                if (body.StringArray("missing") is { } miss) missingItems.AddRange(miss);
            }

            var draft = new TopicDraft(title, description, category, taskTitles);
            TopicRefineResult result;
            try
            {
                result = await claude.RefineTopicAsync(project.Name, project.Tagline, ExistingTopics(storage, pid, tid), draft, ClaudeWorkDir(project.FolderPath), clarifications, ctx.RequestAborted);
            }
            catch
            {
                // If Claude CLI is unavailable, update description with clarifications and add any missing items as tasks
                var fallbackDesc = description;
                if (clarifications.Count > 0)
                {
                    var clarText = "\n\nAnswers:\n" + string.Join("\n", clarifications.Select(c => $"- {c}"));
                    fallbackDesc = string.IsNullOrWhiteSpace(description) ? string.Join("\n", clarifications.Select(c => $"- {c}")) : $"{description}{clarText}";
                }
                result = new TopicRefineResult(title, fallbackDesc, missingItems, ClaudeCli.IdentifyUserActionsFallback(draft, clarifications));
            }

            var updatedTopic = storage.UpdateTopic(pid, tid, result.Title, result.Description, null, null, null, null);

            var existingTasks = storage.ListTasks(pid, tid);
            var existingTaskTitles = new HashSet<string>(existingTasks.Select(t => t.Title.Trim()), StringComparer.OrdinalIgnoreCase);
            var addedTasks = new List<TaskDto>();

            var prereqSet = new HashSet<string>(result.UserActions.Select(u => u.Trim()), StringComparer.OrdinalIgnoreCase);
            foreach (var userAction in result.UserActions)
            {
                var trimmed = userAction.Trim();
                if (!string.IsNullOrWhiteSpace(trimmed))
                {
                    if (existingTaskTitles.Add(trimmed))
                    {
                        addedTasks.Add(storage.AddTask(pid, tid, trimmed, prerequisite: true));
                    }
                    else
                    {
                        var match = existingTasks.FirstOrDefault(t => string.Equals(t.Title.Trim(), trimmed, StringComparison.OrdinalIgnoreCase));
                        if (match != null && !match.Prerequisite)
                        {
                            storage.UpdateTask(pid, match.Id, null, null, null, null, prerequisite: true);
                        }
                    }
                }
            }

            foreach (var taskTitle in result.NewTasks)
            {
                var trimmed = taskTitle.Trim();
                if (!string.IsNullOrWhiteSpace(trimmed) && existingTaskTitles.Add(trimmed))
                {
                    bool isPrereq = prereqSet.Contains(trimmed);
                    addedTasks.Add(storage.AddTask(pid, tid, trimmed, prerequisite: isPrereq));
                }
            }

            var allTasks = storage.ListTasks(pid, tid);
            return new
            {
                topic = updatedTopic,
                tasks = allTasks,
                addedTasks = addedTasks,
                newTasksCount = addedTasks.Count,
                userActions = result.UserActions,
                prerequisites = result.UserActions,
            };
        });

        // ---- tasks
        api.MapGet("/projects/{pid:long}/topics/{tid:long}/tasks", (long pid, long tid) => storage.ListTasks(pid, tid));
        api.MapGet("/projects/{pid:long}/topics/{tid:long}/prerequisites", (long pid, long tid) => storage.ListPrerequisites(pid, tid));
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/tasks", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var complexity = body.Long("complexity").Value is { } c ? (int?)c : null;
            if (complexity is < 1 or > 10) throw new ArgumentException("Task complexity must be between 1 and 10");
            return storage.AddTask(pid, tid, body.String("title") ?? "", body.Bool("prerequisite") ?? false, complexity);
        });
        api.MapPost("/projects/{pid:long}/topics/{tid:long}/tasks/reorder", async (long pid, long tid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.ReorderTasks(pid, tid, body.LongArray("taskIds"));
        });
        api.MapPost("/projects/{pid:long}/tasks/{taskId:long}/move", async (long pid, long taskId, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var toTopic = body.Long("topicId").Value ?? throw new ArgumentException("topicId is required");
            var index = body.Long("index").Value is { } i ? (int?)i : null;
            return storage.MoveTask(pid, taskId, toTopic, index);
        });
        api.MapPatch("/projects/{pid:long}/tasks/{taskId:long}", async (long pid, long taskId, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var complexity = body.Long("complexity").Value is { } c ? (int?)c : null;
            return storage.UpdateTask(pid, taskId, body.String("title"), body.Bool("completed"), body.Long("sortOrder").Value, body.Bool("queued"), body.Bool("prerequisite"), complexity, body.Has("reply"), body.String("reply"), body.Bool("followUp"));
        });
        // For Claude (or a script) to tick a task without JSON quoting. The body is optional plain text:
        // a summary of the steps taken, added to the topic's context file. It's saved even if the task
        // was already ticked, and saved first so a failed write leaves the task open.
        api.MapPost("/projects/{pid:long}/tasks/{taskId:long}/complete", async (long pid, long taskId, HttpContext ctx) =>
        {
            var before = storage.GetTask(pid, taskId);
            var wasDone = before.Completed;
            using var reader = new StreamReader(ctx.Request.Body); // honors a BOM: PowerShell may write UTF-16
            var summary = await reader.ReadToEndAsync(ctx.RequestAborted);
            if (summary.Length > TopicContext.MaxSummaryLength)
                throw new ApiProblem(413, "too_large", $"The summary is too long; the limit is {TopicContext.MaxSummaryLength} characters");
            if (!string.IsNullOrWhiteSpace(summary)) TopicContext.Append(storage.DataRoot, pid, before, summary);
            var task = storage.UpdateTask(pid, taskId, null, true, null);
            // Only Claude's own report moves the queue on. Ticking a task in the UI doesn't reach this.
            if (terminals.ReportTaskCompleted(pid, task, wasDone))
            {
                var (kind, model, effort) = terminals.ChoiceOfFinishedTask(pid, task.Id);
                await StartNextQueuedTask(storage, terminals, pid, task.TopicId, ctx.Connection.LocalPort, kind, model, effort);
            }
            return task;
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

        // ---- Claude and Antigravity plan usage, for the sidebar meter
        // The top bar's choice of model and reasoning level for background work (importing, reviewing, refining).
        api.MapPut("/claude/background-model", (BackgroundModelBody body) =>
        {
            claude.SetBackground(body.Model, body.Effort, body.Service);
            return Results.Json(new { ok = true });
        });
        // Silent mode from the top bar: stops the taskbar flashing. The UI keeps the value and sends it on load.
        api.MapPut("/settings/silent-mode", (SilentModeBody body) =>
        {
            BishopWindow.SilentMode = body.On;
            return Results.Json(new { ok = true });
        });
        // ---- complexity delegation: an app setting, separate from projects
        api.MapGet("/settings/delegation", () => Delegation.Load());
        api.MapPut("/settings/delegation", (DelegationConfig.Config body) => Delegation.Save(body));
        api.MapGet("/claude/usage", (CancellationToken ct) => claude.UsageAsync(ct));
        api.MapGet("/antigravity/usage", (CancellationToken ct) => terminals.AntigravityUsageAsync(ct));

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
            var drafts = await claude.TopicFromTranscriptAsync(project.Name, project.Tagline, ExistingTopics(storage, pid), transcript, ClaudeWorkDir(project.FolderPath), ctx.RequestAborted);
            var category = storage.GetVoiceCategory(pid);
            return drafts.Select(d => d with { Category = category }).ToList();
        });

        // Checks a draft before it's saved, so it comes in the body and not from storage.
        api.MapPost("/projects/{pid:long}/topic-research", async (long pid, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            var title = body.String("title")?.Trim();
            if (string.IsNullOrEmpty(title)) throw new ArgumentException("The topic needs a title");
            var draft = new TopicDraft(title, body.String("description")?.Trim() ?? "", body.String("category") ?? "SOON", body.StringArray("tasks"));
            var project = storage.GetProject(pid);
            var topicId = body.Long("topicId").Value;
            return await claude.ResearchTopicAsync(project.Name, project.Tagline, ExistingTopics(storage, pid, topicId), draft, ClaudeWorkDir(project.FolderPath), ctx.RequestAborted);
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

    /// <summary>
    /// Starts Claude or Antigravity on one task. The task has had its turn now, so it leaves the queue. In same session mode the
    /// topic's live Claude session takes the task, or its last conversation is resumed. With neither, the task starts a new session.
    /// Antigravity always starts a new one: Bishop only keeps Claude conversations.
    /// </summary>
    private static async Task<TerminalInfo> StartTaskSession(Storage storage, Terminals terminals, ProjectDto project, string folder, TopicDto topic, TaskDto task, int port, int cols, int rows, TerminalKind kind, string? model, string? effort)
    {
        // Prerequisites are the user's own work, and agent tasks wait until every one of them is done.
        if (task.Prerequisite)
            throw new ApiProblem(409, "prerequisite_task", "This task is a prerequisite: it is work for you, not for an agent.");
        if (HasOpenPrerequisites(topic))
            throw new ApiProblem(409, "prerequisites_open", "This topic has prerequisites that aren't done yet. Finish them before starting an agent task.");
        // The topic's model family decides the CLI, so a task never runs on a model from the other family.
        var familyKind = topic.ModelFamily == "gemini" ? TerminalKind.Antigravity : TerminalKind.Claude;
        if (kind != familyKind)
        {
            Log.Info($"Task {task.Id}: topic uses the {topic.ModelFamily} family, so it starts on {familyKind} instead of {kind}");
            kind = familyKind;
            // The manual model and level were meant for the other CLI.
            model = null;
            effort = null;
        }
        // agy would start the task behind its trust dialog, where nobody sees it. This also stops queued tasks, which can't ask.
        if (kind == TerminalKind.Antigravity && !terminals.AntigravityTrusts(folder))
            throw new ApiProblem(409, "antigravity_untrusted", "Antigravity doesn't trust this project folder yet, so the task didn't start. Start the task again to answer.");
        // A live task session always has its conversation saved, so this covers handing the task to one too.
        var previous = kind == TerminalKind.Claude && topic.SameSession ? storage.GetTopicClaudeSession(project.Id, topic.Id) : null;
        // The CLI calls back on the port Bishop is listening on right now.
        var categoryName = storage.GetCategories(project.Id).FirstOrDefault(c => c.Key == topic.Category)?.Name ?? topic.Category;
        var brief = TaskBriefs.Write(storage.DataRoot, project, topic, categoryName, task, $"http://127.0.0.1:{port}", continuing: previous is not null);
        Log.Info($"Task brief for task {task.Id}: {brief.Path}");
        var live = previous is not null ? await terminals.ContinueAsync(project.Id, project.Name, brief.Prompt, task) : null;
        TerminalInfo info;
        string? claudeSessionId;
        if (live is not null)
        {
            info = live.Info;
            claudeSessionId = live.ClaudeSessionId;
        }
        else
        {
            claudeSessionId = kind == TerminalKind.Claude ? previous ?? Guid.NewGuid().ToString() : null;
            (model, effort) = await ChooseModelAsync(terminals, kind, topic, task, model, effort);
            info = await terminals.StartAsync(project.Id, project.Name, folder, kind, cols, rows, brief.Prompt, task, claudeSessionId, resume: previous is not null, model: model, effort: effort);
        }
        // Saved in new session mode too: switching to same session continues the latest task's session.
        if (claudeSessionId is not null) storage.SetTopicClaudeSession(project.Id, topic.Id, claudeSessionId);
        if (task.Queued) storage.UpdateTask(project.Id, task.Id, null, null, null, queued: false);
        return info;
    }

    /// <summary>The saved complexity breakdown. Task sessions read it when they pick a model.</summary>
    private static readonly DelegationConfig Delegation = new();

    /// <summary>Open prerequisites hold back the agent tasks. Follow-ups come after the tasks, so they never block.</summary>
    private static bool HasOpenPrerequisites(TopicDto topic) => topic.Tasks.Any(k => k.Prerequisite && !k.FollowUp && !k.Completed);

    /// <summary>
    /// The topic's model and reasoning override wins when it is set and listed. Otherwise this picks the model and reasoning
    /// level for a delegated task from its complexity, so a trivial task doesn't run on the strongest model. The top bar's complexity breakdown decides; with no row for that complexity, the built-in rules do.
    /// The pick replaces the Terminal's manual choice. If the CLI lists no suitable model, or the list can't
    /// be read, the choice passed in stays.
    /// </summary>
    private static async Task<(string? Model, string? Effort)> ChooseModelAsync(Terminals terminals, TerminalKind kind, TopicDto topic, TaskDto task, string? model, string? effort)
    {
        try
        {
            // The topic's own choice beats delegation. It is checked against the CLI's list, because the family may have
            // changed since it was saved. A stale model falls through to automatic delegation.
            if (!string.IsNullOrEmpty(topic.ModelOverride) && kind != TerminalKind.Shell)
            {
                IReadOnlyList<TerminalModel> listed = kind == TerminalKind.Claude ? ClaudeCli.TerminalModels : await terminals.AntigravityModelsAsync(CancellationToken.None);
                var picked = listed.FirstOrDefault(m => m.Id.Equals(topic.ModelOverride, StringComparison.OrdinalIgnoreCase));
                if (picked is not null)
                {
                    // A level this model doesn't offer is dropped, so the CLI uses its own default.
                    var level = topic.EffortOverride is { Length: > 0 } l && picked.Efforts.Contains(l, StringComparer.OrdinalIgnoreCase) ? l : null;
                    Log.Info($"Task {task.Id} runs on {picked.Id} {level} from the topic's override");
                    return (picked.Id, level);
                }
                Log.Info($"Task {task.Id}: the topic's model {topic.ModelOverride} isn't listed for {kind}, so delegation applies");
            }
            // The top bar's complexity breakdown comes first. A row with no model or level uses the CLI default for it.
            var mode = kind == TerminalKind.Antigravity ? "antigravity" : kind == TerminalKind.Claude ? "claude" : null;
            if (mode is not null
                && Delegation.Load().Choices.GetValueOrDefault(mode)?.GetValueOrDefault(Math.Clamp(task.Complexity, 1, 10).ToString()) is { } row)
            {
                IReadOnlyList<TerminalModel> listed = kind == TerminalKind.Claude ? ClaudeCli.TerminalModels : await terminals.AntigravityModelsAsync(CancellationToken.None);
                // A model that is no longer listed would fail to start, so that row is skipped.
                if (row.Model is null || listed.Any(m => m.Id.Equals(row.Model, StringComparison.OrdinalIgnoreCase)))
                {
                    Log.Info($"Task {task.Id} (complexity {task.Complexity}) runs on {row.Model ?? "the default model"} {row.Effort} from the complexity breakdown");
                    return (row.Model, row.Effort);
                }
                Log.Info($"Task {task.Id}: the breakdown's model {row.Model} isn't listed, so the built-in pick applies");
            }
            (string Model, string? Effort)? pick = kind switch
            {
                TerminalKind.Claude => ClaudeCli.PickModel(task.Complexity, ClaudeCli.TerminalModels),
                TerminalKind.Antigravity => AntigravityCli.PickModel(task.Complexity, await terminals.AntigravityModelsAsync(CancellationToken.None)),
                _ => null,
            };
            if (pick is { } p)
            {
                Log.Info($"Task {task.Id} (complexity {task.Complexity}) runs on {p.Model} {p.Effort}");
                return (p.Model, p.Effort);
            }
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't pick a model for task {task.Id}: {ex.Message}");
        }
        return (model, effort);
    }

    /// <summary>
    /// Starts the next queued task: the finished task's topic first, then the project's other topics in overview order.
    /// A failure only logs and the task stays queued, because the task that just finished is still done.
    /// The host doesn't know the Terminal's saved choice, so the task runs on the CLI, model and reasoning level of the one before it.
    /// </summary>
    private static async Task StartNextQueuedTask(Storage storage, Terminals terminals, long projectId, long topicId, int port, TerminalKind kind, string? model, string? effort)
    {
        try
        {
            if (terminals.IsBusy(projectId)) return;
            var categories = storage.GetCategories(projectId).Select(c => c.Key).ToList();
            var topics = storage.ListTopics(projectId)
                .Where(t => t.ArchivedAt is null)
                .OrderBy(t => t.Id != topicId)
                .ThenBy(t => categories.IndexOf(t.Category))
                .ThenBy(t => t.SortOrder);
            foreach (var topic in topics)
            {
                // A topic with open prerequisites keeps its queued tasks waiting.
                if (HasOpenPrerequisites(topic)) continue;
                var next = topic.Tasks.Where(k => k.Queued && !k.Completed && !k.Prerequisite).OrderBy(k => k.SortOrder).ThenBy(k => k.Id).FirstOrDefault();
                if (next is null) continue;
                Log.Info($"Starting queued task {next.Id}: {next.Title}");
                await StartTaskSession(storage, terminals, storage.GetProject(projectId), RequireFolder(storage, projectId), topic, next, port, 120, 30, kind, model, effort);
                return;
            }
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't start the next queued task: {ex.Message}");
        }
    }

    /// <summary>Open topic titles by category, in board order, for Claude. Claude sees the names, because added categories have generated keys.</summary>
    private static List<CategoryTopics> ExistingTopics(Storage storage, long projectId, long? excludeTopicId = null)
    {
        var topics = storage.ListTopics(projectId).Where(t => t.ArchivedAt is null && (excludeTopicId is null || t.Id != excludeTopicId.Value)).ToList();
        return storage.GetCategories(projectId)
            .Select(c => new CategoryTopics(c.Name, topics.Where(t => t.Category == c.Key).Select(t => t.Title).ToList()))
            .ToList();
    }

    private static string? ClaudeWorkDir(string? folderPath) =>
        folderPath is not null && Directory.Exists(folderPath) ? folderPath : null;

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

        public bool Has(string name) => TryGet(name, out _);

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

        /// <summary>The non-blank strings in an array, trimmed. Absent reads as empty.</summary>
        public List<string> StringArray(string name)
        {
            if (!TryGet(name, out var el)) return [];
            if (el.ValueKind != JsonValueKind.Array) throw new ArgumentException($"'{name}' must be an array of strings");
            var list = new List<string>();
            foreach (var item in el.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) throw new ArgumentException($"'{name}' must contain only strings");
                if (item.GetString()!.Trim() is { Length: > 0 } s) list.Add(s);
            }
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

public record SilentModeBody(bool On);
public record BackgroundModelBody(string? Model, string? Effort, string? Service = null);
