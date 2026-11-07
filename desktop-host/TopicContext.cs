using System.Text;

namespace Bishop;

/// <summary>
/// One Markdown file per topic, at <c>&lt;data root&gt;\context\&lt;project id&gt;\topic-&lt;topic id&gt;.md</c>.
/// When Claude finishes a task it sends a summary of the steps it took, and Bishop appends it here, so
/// the file is a running record of the work done on the topic. It lives in the data root because Bishop
/// doesn't write to project folders. Backups include it, and deleting moves it to trash (see Storage).
/// </summary>
public static class TopicContext
{
    public const int MaxSummaryLength = 20_000;

    private static readonly object Gate = new();

    public record ContextFile(string Path, bool Exists, string Content);

    public static string Root(string dataRoot) => System.IO.Path.Combine(dataRoot, "context");

    public static string ProjectDir(string dataRoot, long projectId) =>
        System.IO.Path.Combine(Root(dataRoot), projectId.ToString());

    public static string FilePath(string dataRoot, long projectId, long topicId) =>
        System.IO.Path.Combine(ProjectDir(dataRoot, projectId), $"topic-{topicId}.md");

    public static ContextFile Read(string dataRoot, long projectId, long topicId)
    {
        var path = FilePath(dataRoot, projectId, topicId);
        lock (Gate)
        {
            return File.Exists(path) ? new ContextFile(path, true, File.ReadAllText(path)) : new ContextFile(path, false, "");
        }
    }

    /// <summary>Adds one entry to the end of the topic's file, creating it if needed.</summary>
    public static void Append(string dataRoot, long projectId, TaskDto task, string summary)
    {
        var path = FilePath(dataRoot, projectId, task.TopicId);
        var entry = new StringBuilder();
        entry.AppendLine($"## {task.Title.ReplaceLineEndings(" ")}");
        entry.AppendLine();
        entry.AppendLine($"Completed {DateTime.Now:yyyy-MM-dd HH:mm}");
        entry.AppendLine();
        entry.AppendLine(summary.Trim());
        entry.AppendLine();
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(ProjectDir(dataRoot, projectId));
                File.AppendAllText(path, entry.ToString(), new UTF8Encoding(false));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Info($"Couldn't write {path}: {ex.Message}");
            throw new ApiProblem(500, "context_write_failed", $"Couldn't save the summary to the topic's context file: {ex.Message}");
        }
    }
}
