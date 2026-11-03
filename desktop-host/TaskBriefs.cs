using System.Text;

namespace Bishop;

/// <summary>
/// "Work on this task with Claude": writes a brief (the topic, its tasks, and how to mark the task done)
/// to <c>&lt;data root&gt;\work\</c> and builds the short prompt that points Claude at it. Task text never
/// goes on the command line, because the npm shim runs through cmd.exe.
/// </summary>
public static class TaskBriefs
{
    private static readonly TimeSpan KeepFor = TimeSpan.FromDays(7);

    public record Brief(string Path, string Prompt);

    public static Brief Write(string dataRoot, ProjectDto project, TopicDto topic, TaskDto task, string apiBase)
    {
        var dir = System.IO.Path.Combine(dataRoot, "work");
        Directory.CreateDirectory(dir);
        Cleanup(dir);

        var path = System.IO.Path.Combine(dir, $"task-{project.Id}-{task.Id}-{DateTime.Now:yyyyMMdd-HHmmss}.md");
        // The path ends up inside a quoted cmd.exe argument, where % would still expand.
        if (path.Contains('%') || path.Contains('"'))
            throw new ApiProblem(409, "bad_data_path", "The data folder path contains % or a quote, so Bishop can't hand a task to Claude.");

        File.WriteAllText(path, Render(project, topic, task, apiBase), new UTF8Encoding(false));
        var prompt = $"Bishop sent you a task to work on. Read the brief in '{path}' and follow it.";
        return new Brief(path, prompt);
    }

    private static string Render(ProjectDto project, TopicDto topic, TaskDto task, string apiBase)
    {
        var tasks = topic.Tasks.OrderBy(t => t.SortOrder).ThenBy(t => t.Id).ToList();
        var complete = $"curl.exe -s -X POST {apiBase}/api/projects/{project.Id}/tasks/{task.Id}/complete";
        var sb = new StringBuilder();
        sb.AppendLine($"# Task: {task.Title}");
        sb.AppendLine();
        sb.AppendLine($"This task comes from Bishop, the project manager for the project \"{project.Name}\". " +
                      "It belongs to the topic below. Work on this one task only.");
        sb.AppendLine();
        sb.AppendLine($"## Topic: {topic.Title}");
        sb.AppendLine();
        sb.AppendLine($"Category: {CategoryLabel(topic.Category)}");
        sb.AppendLine();
        sb.AppendLine(string.IsNullOrWhiteSpace(topic.Description) ? "(No description.)" : topic.Description.Trim());
        sb.AppendLine();
        sb.AppendLine("## Tasks in this topic");
        sb.AppendLine();
        sb.AppendLine("Done tasks show work that already happened. Open tasks other than yours are for later; don't do them now.");
        sb.AppendLine();
        foreach (var t in tasks)
        {
            var mark = t.Completed ? "[x]" : "[ ]";
            var you = t.Id == task.Id ? "   <- your task" : "";
            sb.AppendLine($"- {mark} {t.Title}{you}");
        }
        sb.AppendLine();
        sb.AppendLine("## When you're done");
        sb.AppendLine();
        sb.AppendLine("1. Make the change and check it the way AGENTS.md describes (builds, checks, README).");
        sb.AppendLine("2. Give a short summary of what you did.");
        sb.AppendLine("3. Mark the task as done in Bishop by running:");
        sb.AppendLine();
        sb.AppendLine($"       {complete}");
        sb.AppendLine();
        sb.AppendLine("   It returns the task as JSON with \"completed\": true. If Bishop was restarted and the call fails, " +
                      "tell the user to tick the task in Bishop instead.");
        sb.AppendLine();
        sb.AppendLine("If you couldn't finish the task, or you need a decision from the user, don't mark it as done; say what's left.");
        return sb.ToString();
    }

    private static string CategoryLabel(string category) => category switch
    {
        "RIGHT_NOW" => "Right now",
        "SOON" => "Soon",
        "LATER" => "Later",
        _ => "Backlog",
    };

    /// <summary>Old briefs are Bishop's own scratch files; drop ones older than a week.</summary>
    private static void Cleanup(string dir)
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(dir, "task-*.md"))
            {
                if (DateTime.UtcNow - File.GetLastWriteTimeUtc(f) > KeepFor) File.Delete(f);
            }
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't clean old task briefs: {ex.Message}");
        }
    }
}
