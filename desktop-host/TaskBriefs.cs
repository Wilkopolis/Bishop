using System.Text;

namespace Bishop;

/// <summary>
/// "Work on this task with Claude": writes a brief (the topic's context file if it has one, the topic, its tasks with the user's answers, how to report
/// the steps taken and mark the task done)
/// to <c>&lt;data root&gt;\work\</c> and builds the short prompt that points Claude at it. Task text never
/// goes on the command line, because the npm shim runs through cmd.exe. A brief for a session that continues the topic's
/// conversation leaves the context file out: Claude remembers the work, so it neither reads the file nor adds to it.
/// </summary>
public static class TaskBriefs
{
    private static readonly TimeSpan KeepFor = TimeSpan.FromDays(7);

    public record Brief(string Path, string Prompt);

    /// <param name="categoryName">The name of the topic's category in this project.</param>
    /// <param name="continuing">The task goes to a session that already has the topic's conversation.</param>
    public static Brief Write(string dataRoot, ProjectDto project, TopicDto topic, string categoryName, TaskDto task, string apiBase, bool continuing)
    {
        var dir = System.IO.Path.Combine(dataRoot, "work");
        Directory.CreateDirectory(dir);
        Cleanup(dir);

        var path = System.IO.Path.Combine(dir, $"task-{project.Id}-{task.Id}-{DateTime.Now:yyyyMMdd-HHmmss}.md");
        // The path ends up inside a quoted cmd.exe argument, where % would still expand.
        if (path.Contains('%') || path.Contains('"'))
            throw new ApiProblem(409, "bad_data_path", "The data folder path contains % or a quote, so Bishop can't hand a task to Claude.");

        // Claude writes its summary here and posts the file, so the text never needs shell quoting.
        // The name matches task-*.md, so Cleanup drops it along with the brief.
        var summaryPath = continuing ? null : System.IO.Path.ChangeExtension(path, null) + "-summary.md";
        var contextPath = TopicContext.FilePath(dataRoot, project.Id, topic.Id);
        var context = !continuing && File.Exists(contextPath) ? contextPath : null;
        File.WriteAllText(path, Render(project, topic, categoryName, task, apiBase, summaryPath, context), new UTF8Encoding(false));
        var prompt = $"Bishop sent you a task to work on. Read the brief in '{path}' and follow it.";
        return new Brief(path, prompt);
    }

    /// <param name="summaryPath">Where Claude writes its summary. Null when the session continues: then no summary is asked for.</param>
    private static string Render(ProjectDto project, TopicDto topic, string categoryName, TaskDto task, string apiBase, string? summaryPath, string? contextPath)
    {
        var tasks = topic.Tasks.OrderBy(t => t.SortOrder).ThenBy(t => t.Id).ToList();
        var complete = $"curl.exe -sS -X POST {apiBase}/api/projects/{project.Id}/tasks/{task.Id}/complete";
        if (summaryPath != null) complete += $" --data-binary \"@{summaryPath}\"";
        var sb = new StringBuilder();
        sb.AppendLine($"# Task: {task.Title}");
        sb.AppendLine();
        sb.AppendLine($"This task comes from Bishop, the project manager for the project \"{project.Name}\". " +
                      "It belongs to the topic below. Work on this one task only.");
        sb.AppendLine();
        if (contextPath != null)
        {
            sb.AppendLine("## Read this first");
            sb.AppendLine();
            sb.AppendLine("This topic has a context file: summaries of the steps taken on its finished tasks. " +
                          "Read it before you start on your task, so you build on that work. Don't edit it; Bishop keeps it.");
            sb.AppendLine();
            sb.AppendLine($"       {contextPath}");
            sb.AppendLine();
        }
        if (summaryPath == null)
        {
            sb.AppendLine("You are continuing your session on this topic, so you already know the work done on it. " +
                          "This task has no context file to read and no summary file to write, even if an earlier brief had them.");
            sb.AppendLine();
        }
        sb.AppendLine($"## Topic: {topic.Title}");
        sb.AppendLine();
        sb.AppendLine($"Category: {categoryName}");
        sb.AppendLine();
        sb.AppendLine(string.IsNullOrWhiteSpace(topic.Description) ? "(No description.)" : topic.Description.Trim());
        sb.AppendLine();
        sb.AppendLine("## Tasks in this topic");
        sb.AppendLine();
        sb.AppendLine("Done tasks show work that already happened. Open tasks other than yours are for later; don't do them now.");
        if (tasks.Any(HasAnswer))
            sb.AppendLine("Quoted text under a task is the user's written answer to it. Treat it as their decision.");
        sb.AppendLine();
        foreach (var t in tasks)
        {
            var mark = t.Completed ? "[x]" : "[ ]";
            var you = t.Id == task.Id ? "   <- your task" : "";
            sb.AppendLine($"- {mark} {t.Title}{you}");
            if (!HasAnswer(t)) continue;
            foreach (var line in t.Reply!.Trim().ReplaceLineEndings("\n").Split('\n'))
                sb.AppendLine($"  > {line}".TrimEnd());
        }
        sb.AppendLine();
        sb.AppendLine("## When you're done");
        sb.AppendLine();
        sb.AppendLine("1. Make the change and check it the way AGENTS.md describes (builds, checks, README).");
        sb.AppendLine("2. Give a short summary of what you did.");
        if (summaryPath != null)
        {
            sb.AppendLine("3. Write a summary of the steps you took to this file, for whoever works on this topic next:");
            sb.AppendLine();
            sb.AppendLine($"       {summaryPath}");
            sb.AppendLine();
            sb.AppendLine("   Use a few short Markdown bullets, no headings: what changed and why, the main files, decisions made, " +
                          "and anything left to watch for. Keep it under 2,000 characters.");
            sb.AppendLine("4. Mark the task as done in Bishop and save that summary to the topic's context file by running:");
        }
        else
        {
            sb.AppendLine("3. Mark the task as done in Bishop by running:");
        }
        sb.AppendLine();
        sb.AppendLine($"       {complete}");
        sb.AppendLine();
        sb.AppendLine("   It returns the task as JSON with \"completed\": true. If Bishop was restarted and the call fails, " +
                      "tell the user to tick the task in Bishop instead.");
        sb.AppendLine();
        sb.AppendLine("If you couldn't finish the task, or you need a decision from the user, don't mark it as done; say what's left.");
        return sb.ToString();
    }

    /// <summary>A reply only counts as the answer once the user completes their task. Until then it's a draft.</summary>
    private static bool HasAnswer(TaskDto task) => task.Prerequisite && task.Completed && !string.IsNullOrWhiteSpace(task.Reply);

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
