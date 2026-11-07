using System.Security.Cryptography;
using System.Text;

namespace Bishop;

public record AgentsFile(string Path, bool Exists, string Content, string Hash);

/// <summary>
/// A project's working folder on disk. Bishop only ever adds AGENTS.md there (when missing);
/// it never moves, overwrites or deletes anything else in the folder.
/// </summary>
public static class ProjectFolders
{
    public const string AgentsFileName = "AGENTS.md";

    /// <summary>Validates and normalizes a user-entered folder path.</summary>
    public static string Normalize(string? path)
    {
        var p = (path ?? "").Trim().Trim('"').Trim();
        if (p.Length == 0) throw new ArgumentException("Choose a folder for the project");
        p = Environment.ExpandEnvironmentVariables(p);
        if (!Path.IsPathFullyQualified(p)) throw new ArgumentException("The folder must be a full path, like C:\\Projects\\MyProject");
        if (p.IndexOfAny(Path.GetInvalidPathChars()) >= 0) throw new ArgumentException("The folder path contains invalid characters");
        var full = Path.GetFullPath(p);
        var root = Path.GetPathRoot(full);
        if (string.Equals(full.TrimEnd('\\', '/'), root?.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Pick a folder, not a whole drive");
        return full.TrimEnd('\\', '/');
    }

    /// <summary>Default suggestion: &lt;projects root&gt;\&lt;project name&gt; with unsafe characters replaced.</summary>
    public static string Suggest(string projectsRoot, string? name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string((name ?? "").Trim().Select(c => invalid.Contains(c) ? '-' : c).ToArray()).Trim(' ', '.');
        if (safe.Length == 0) safe = "New project";
        return Path.Combine(projectsRoot, safe);
    }

    public static object Status(string path)
    {
        var exists = Directory.Exists(path);
        return new
        {
            path,
            exists,
            hasAgents = exists && File.Exists(Path.Combine(path, AgentsFileName)),
            isFile = File.Exists(path),
        };
    }

    /// <summary>Creates the folder if needed and adds AGENTS.md if there isn't one. Returns whether AGENTS.md was created.</summary>
    public static bool Link(string folder, string projectName, string? tagline)
    {
        if (File.Exists(folder)) throw new ArgumentException("That path is a file, not a folder");
        try
        {
            Directory.CreateDirectory(folder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ArgumentException($"Couldn't create the folder: {ex.Message}");
        }

        var agents = Path.Combine(folder, AgentsFileName);
        if (File.Exists(agents)) return false;
        try
        {
            // CreateNew: never overwrite, even if the file appeared since the check.
            using var stream = new FileStream(agents, FileMode.CreateNew, FileAccess.Write);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.Write(Template(projectName, tagline));
            Log.Info($"Created {agents}");
            return true;
        }
        catch (IOException) when (File.Exists(agents))
        {
            return false;
        }
    }

    public static string Template(string projectName, string? tagline) => $"""
        # {projectName}

        {(string.IsNullOrWhiteSpace(tagline) ? "_One-line description of the project._" : tagline)}

        ## About this project

        _What is this project? Who is it for? Anything an assistant should know before helping:
        goals, constraints, tech stack, people involved, links._

        ## Notes for agents

        This project is tracked in **Bishop**, a local project manager. Bishop organizes work into
        **topics** (a piece of work or an idea, with a short description) and each topic has a
        checklist of **tasks**. Every topic sits in one category. Projects can add and remove
        categories; these are the ones a project starts with:

        - **RIGHT NOW**: being worked on now, or urgent
        - **SOON**: next up
        - **LATER**: planned, but not soon
        - **BACKLOG**: someday, ideas, or unclear timing

        When Bishop asks you to turn a voice note into a topic, follow the conventions above and any
        project-specific instructions in this file.

        ## Project-specific instructions

        _Add preferences here, e.g. naming conventions for topic titles, words to use or avoid,
        how to split work into tasks._

        """.Replace("\n", Environment.NewLine);

    private static string HashOf(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public static AgentsFile ReadAgents(string folder)
    {
        var path = Path.Combine(folder, AgentsFileName);
        if (!File.Exists(path)) return new AgentsFile(path, false, "", "");
        var bytes = File.ReadAllBytes(path);
        return new AgentsFile(path, true, Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'), HashOf(bytes));
    }

    /// <summary>
    /// Saves AGENTS.md. If it changed on disk since it was loaded (hash differs from <paramref name="baseHash"/>)
    /// and <paramref name="force"/> is false, refuses with 409 so the UI can warn.
    /// </summary>
    public static AgentsFile WriteAgents(string folder, string content, string? baseHash, bool force)
    {
        if (!Directory.Exists(folder)) throw new ApiProblem(409, "folder_missing", $"The project folder doesn't exist: {folder}");
        var current = ReadAgents(folder);
        if (!force && current.Hash != (baseHash ?? ""))
            throw new ApiProblem(409, "changed_on_disk", "AGENTS.md was changed outside Bishop since you opened it.");

        // Keep the file's existing line-ending style (Windows editors usually use CRLF).
        var text = content.Replace("\r\n", "\n");
        var crlf = current.Exists ? current.Content.Contains("\r\n") : true;
        if (crlf) text = text.Replace("\n", "\r\n");
        File.WriteAllText(current.Path, text, new UTF8Encoding(false));
        return ReadAgents(folder);
    }
}
