using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Bishop;

/// <summary>Minimal JSON API over <see cref="Storage"/>, plus frameless-window controls.</summary>
public static class Api
{
    public static void MapBishopApi(this WebApplication app, Storage storage, Func<BishopWindow?> window)
    {
        // Map storage exceptions to HTTP status codes.
        app.Use(async (ctx, next) =>
        {
            try
            {
                await next(ctx);
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
            return storage.CreateProject(body.String("name") ?? "", body.Long("folderId").Value);
        });
        api.MapPatch("/projects/{id:long}", async (long id, HttpContext ctx) =>
        {
            var body = await ReadBody(ctx);
            return storage.UpdateProject(id, body.String("name"), body.Long("folderId"));
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
                case "close": win?.CloseWindow(); break;
                default: return Results.NotFound();
            }
            return Results.Json(new { ok = true });
        });
    }

    private static async Task WriteError(HttpContext ctx, int status, string message)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error = message });
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
