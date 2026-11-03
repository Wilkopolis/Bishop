using Microsoft.Data.Sqlite;

namespace Bishop;

public record FolderDto(long Id, string Name, long? ParentId, long SortOrder, string CreatedAt);

public record ProjectDto(long Id, string Name, long? FolderId, long SortOrder, string CreatedAt, string UpdatedAt);

public record TaskDto(long Id, long TopicId, string Title, bool Completed, long SortOrder, string CreatedAt, string? CompletedAt);

public record TopicDto(long Id, string Title, string Description, string Category, long SortOrder, string CreatedAt, string UpdatedAt, List<TaskDto> Tasks);

public record TreeDto(List<FolderDto> Folders, List<ProjectDto> Projects);

public record SearchHit(long ProjectId, string ProjectName, long TopicId, string TopicTitle, string Category, string MatchKind, string Snippet);

/// <summary>Thrown for missing rows; mapped to HTTP 404.</summary>
public class NotFoundException(string message) : Exception(message);

/// <summary>
/// SQLite-backed storage. Layout under the data root:
///   index.db            folders + projects tree
///   projects/{n}.db     one database per project (topics + tasks)
///   trash/              deleted project databases (moved, not destroyed)
/// </summary>
public partial class Storage
{
    public static readonly string[] Categories = ["RIGHT_NOW", "SOON", "LATER", "BACKLOG"];

    private const int IndexSchemaVersion = 1;
    private const int ProjectSchemaVersion = 1;

    public string DataRoot { get; }
    private string IndexPath => Path.Combine(DataRoot, "index.db");
    private string ProjectsDir => Path.Combine(DataRoot, "projects");
    private string TrashDir => Path.Combine(DataRoot, "trash");

    public Storage(string dataRoot)
    {
        DataRoot = dataRoot;
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(ProjectsDir);
        InitIndex();
    }

    private static string Now() => DateTime.UtcNow.ToString("o");

    private static SqliteConnection Open(string path)
    {
        // Pooling off so project files can be moved to trash immediately after use.
        var conn = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Pooling = false,
            DefaultTimeout = 10,
        }.ToString());
        conn.Open();
        Exec(conn, "PRAGMA foreign_keys = ON;");
        return conn;
    }

    private static void Exec(SqliteConnection conn, string sql, params (string, object?)[] args)
    {
        using var cmd = Command(conn, sql, args);
        cmd.ExecuteNonQuery();
    }

    private static object? Scalar(SqliteConnection conn, string sql, params (string, object?)[] args)
    {
        using var cmd = Command(conn, sql, args);
        return cmd.ExecuteScalar();
    }

    private static SqliteCommand Command(SqliteConnection conn, string sql, (string, object?)[] args)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }
        return cmd;
    }

    private static long? NullableLong(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt64(i);

    // ---------------------------------------------------------------- index

    private void InitIndex()
    {
        using var conn = Open(IndexPath);
        Exec(conn, "PRAGMA journal_mode = WAL;");
        var version = Convert.ToInt32(Scalar(conn, "PRAGMA user_version;"));
        if (version >= IndexSchemaVersion) return;

        Exec(conn, $"""
            CREATE TABLE IF NOT EXISTS folders (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                parent_id   INTEGER NULL REFERENCES folders(id),
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                folder_id   INTEGER NULL REFERENCES folders(id),
                file_name   TEXT    NOT NULL UNIQUE,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_folders_parent ON folders(parent_id);
            CREATE INDEX IF NOT EXISTS ix_projects_folder ON projects(folder_id);
            PRAGMA user_version = {IndexSchemaVersion};
            """);
    }

    public TreeDto GetTree()
    {
        using var conn = Open(IndexPath);
        var folders = new List<FolderDto>();
        using (var cmd = Command(conn, "SELECT id, name, parent_id, sort_order, created_at FROM folders ORDER BY sort_order, id", []))
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
                folders.Add(new FolderDto(r.GetInt64(0), r.GetString(1), NullableLong(r, 2), r.GetInt64(3), r.GetString(4)));
        }
        var projects = new List<ProjectDto>();
        using (var cmd = Command(conn, "SELECT id, name, folder_id, sort_order, created_at, updated_at FROM projects ORDER BY sort_order, id", []))
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
                projects.Add(ReadProject(r));
        }
        return new TreeDto(folders, projects);
    }

    private static ProjectDto ReadProject(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), NullableLong(r, 2), r.GetInt64(3), r.GetString(4), r.GetString(5));

    private static void EnsureFolderExists(SqliteConnection conn, long? folderId)
    {
        if (folderId is null) return;
        if (Scalar(conn, "SELECT 1 FROM folders WHERE id = $id", ("$id", folderId)) is null)
            throw new NotFoundException($"Folder {folderId} not found");
    }

    private static FolderDto GetFolder(SqliteConnection conn, long id)
    {
        using var cmd = Command(conn, "SELECT id, name, parent_id, sort_order, created_at FROM folders WHERE id = $id", [("$id", id)]);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Folder {id} not found");
        return new FolderDto(r.GetInt64(0), r.GetString(1), NullableLong(r, 2), r.GetInt64(3), r.GetString(4));
    }

    private static string RequireName(string? name, string what)
    {
        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed)) throw new ArgumentException($"{what} is required");
        return trimmed;
    }

    public FolderDto CreateFolder(string name, long? parentId)
    {
        name = RequireName(name, "Folder name");
        using var conn = Open(IndexPath);
        EnsureFolderExists(conn, parentId);
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS $p", ("$p", parentId)));
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO folders (name, parent_id, sort_order, created_at) VALUES ($n, $p, $s, $c) RETURNING id",
            ("$n", name), ("$p", parentId), ("$s", sort), ("$c", Now())));
        return GetFolder(conn, id);
    }

    /// <summary>Rename and/or move a folder. parentId: None = keep, Some(null) = move to root.</summary>
    public FolderDto UpdateFolder(long id, string? name, Optional<long?> parentId)
    {
        using var conn = Open(IndexPath);
        GetFolder(conn, id);
        if (name is not null)
        {
            Exec(conn, "UPDATE folders SET name = $n WHERE id = $id", ("$n", RequireName(name, "Folder name")), ("$id", id));
        }
        if (parentId.HasValue)
        {
            var newParent = parentId.Value;
            EnsureFolderExists(conn, newParent);
            // Reject cycles: the new parent must not be this folder or one of its descendants.
            for (long? cur = newParent; cur is not null; cur = GetFolder(conn, cur.Value).ParentId)
            {
                if (cur == id) throw new ArgumentException("Cannot move a folder into itself");
            }
            Exec(conn, "UPDATE folders SET parent_id = $p WHERE id = $id", ("$p", newParent), ("$id", id));
        }
        return GetFolder(conn, id);
    }

    /// <summary>Deletes a folder; its child folders and projects move up to its parent.</summary>
    public void DeleteFolder(long id)
    {
        using var conn = Open(IndexPath);
        var folder = GetFolder(conn, id);
        using var tx = conn.BeginTransaction();
        Exec(conn, "UPDATE folders SET parent_id = $p WHERE parent_id = $id", ("$p", folder.ParentId), ("$id", id));
        Exec(conn, "UPDATE projects SET folder_id = $p WHERE folder_id = $id", ("$p", folder.ParentId), ("$id", id));
        Exec(conn, "DELETE FROM folders WHERE id = $id", ("$id", id));
        tx.Commit();
    }

    private static ProjectDto GetProject(SqliteConnection conn, long id)
    {
        using var cmd = Command(conn, "SELECT id, name, folder_id, sort_order, created_at, updated_at FROM projects WHERE id = $id", [("$id", id)]);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Project {id} not found");
        return ReadProject(r);
    }

    public ProjectDto GetProject(long id)
    {
        using var conn = Open(IndexPath);
        return GetProject(conn, id);
    }

    public ProjectDto CreateProject(string name, long? folderId)
    {
        name = RequireName(name, "Project name");
        using var conn = Open(IndexPath);
        EnsureFolderExists(conn, folderId);
        var now = Now();
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects WHERE folder_id IS $f", ("$f", folderId)));
        var fileName = $"{Guid.NewGuid():N}.db";
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO projects (name, folder_id, file_name, sort_order, created_at, updated_at) VALUES ($n, $f, $file, $s, $c, $c) RETURNING id",
            ("$n", name), ("$f", folderId), ("$file", fileName), ("$s", sort), ("$c", now)));
        InitProjectDb(Path.Combine(ProjectsDir, fileName));
        return GetProject(conn, id);
    }

    public ProjectDto UpdateProject(long id, string? name, Optional<long?> folderId)
    {
        using var conn = Open(IndexPath);
        GetProject(conn, id);
        if (name is not null)
        {
            Exec(conn, "UPDATE projects SET name = $n, updated_at = $u WHERE id = $id",
                ("$n", RequireName(name, "Project name")), ("$u", Now()), ("$id", id));
        }
        if (folderId.HasValue)
        {
            EnsureFolderExists(conn, folderId.Value);
            Exec(conn, "UPDATE projects SET folder_id = $f, updated_at = $u WHERE id = $id",
                ("$f", folderId.Value), ("$u", Now()), ("$id", id));
        }
        return GetProject(conn, id);
    }

    /// <summary>
    /// Places the given projects, in order, in a folder (null = root). Projects not listed
    /// keep their folder; listed ones are moved here and renumbered 0..n-1.
    /// </summary>
    public List<ProjectDto> ReorderProjects(long? folderId, IReadOnlyList<long> projectIds)
    {
        using var conn = Open(IndexPath);
        EnsureFolderExists(conn, folderId);
        using var tx = conn.BeginTransaction();
        var now = Now();
        for (int i = 0; i < projectIds.Count; i++)
        {
            GetProject(conn, projectIds[i]);
            Exec(conn, "UPDATE projects SET folder_id = $f, sort_order = $s, updated_at = CASE WHEN folder_id IS $f THEN updated_at ELSE $u END WHERE id = $id",
                ("$f", folderId), ("$s", i), ("$u", now), ("$id", projectIds[i]));
        }
        tx.Commit();
        return GetTree().Projects;
    }

    /// <summary>Removes the project from the index and moves its database into trash/.</summary>
    public void DeleteProject(long id)
    {
        using var conn = Open(IndexPath);
        GetProject(conn, id);
        var fileName = (string)Scalar(conn, "SELECT file_name FROM projects WHERE id = $id", ("$id", id))!;
        Exec(conn, "DELETE FROM projects WHERE id = $id", ("$id", id));

        var src = Path.Combine(ProjectsDir, fileName);
        if (File.Exists(src))
        {
            Directory.CreateDirectory(TrashDir);
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
            File.Move(src, Path.Combine(TrashDir, $"{stamp}-{id}-{fileName}"));
        }
    }

    // -------------------------------------------------------------- projects

    private static void InitProjectDb(string path)
    {
        using var conn = Open(path);
        var version = Convert.ToInt32(Scalar(conn, "PRAGMA user_version;"));
        if (version >= ProjectSchemaVersion) return;

        var categoryList = string.Join(",", Categories.Select(c => $"'{c}'"));
        Exec(conn, $"""
            CREATE TABLE IF NOT EXISTS topics (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT    NOT NULL,
                description  TEXT    NOT NULL DEFAULT '',
                category     TEXT    NOT NULL DEFAULT 'BACKLOG' CHECK (category IN ({categoryList})),
                sort_order   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT    NOT NULL,
                updated_at   TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                title        TEXT    NOT NULL,
                completed    INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                sort_order   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT    NOT NULL,
                completed_at TEXT    NULL
            );
            CREATE INDEX IF NOT EXISTS ix_topics_category ON topics(category, sort_order);
            CREATE INDEX IF NOT EXISTS ix_tasks_topic ON tasks(topic_id, sort_order);
            PRAGMA user_version = {ProjectSchemaVersion};
            """);
    }

    private SqliteConnection OpenProject(long projectId)
    {
        string fileName;
        using (var index = Open(IndexPath))
        {
            fileName = Scalar(index, "SELECT file_name FROM projects WHERE id = $id", ("$id", projectId)) as string
                ?? throw new NotFoundException($"Project {projectId} not found");
        }
        var path = Path.Combine(ProjectsDir, fileName);
        InitProjectDb(path); // recreates schema if the file went missing
        return Open(path);
    }

    private void TouchProject(long projectId)
    {
        using var index = Open(IndexPath);
        Exec(index, "UPDATE projects SET updated_at = $u WHERE id = $id", ("$u", Now()), ("$id", projectId));
    }

    private static string RequireCategory(string? category)
    {
        var c = category?.Trim().ToUpperInvariant();
        if (c is null || !Categories.Contains(c))
            throw new ArgumentException($"Category must be one of {string.Join(", ", Categories)}");
        return c;
    }

    private static List<TaskDto> ReadTasks(SqliteConnection conn, long? topicId)
    {
        var sql = "SELECT id, topic_id, title, completed, sort_order, created_at, completed_at FROM tasks"
            + (topicId is null ? "" : " WHERE topic_id = $t")
            + " ORDER BY sort_order, id";
        using var cmd = Command(conn, sql, topicId is null ? [] : [("$t", topicId)]);
        using var r = cmd.ExecuteReader();
        var list = new List<TaskDto>();
        while (r.Read())
        {
            list.Add(new TaskDto(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3) != 0,
                r.GetInt64(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6)));
        }
        return list;
    }

    private static List<TopicDto> ReadTopics(SqliteConnection conn, long? topicId)
    {
        var tasksByTopic = ReadTasks(conn, topicId).GroupBy(t => t.TopicId).ToDictionary(g => g.Key, g => g.ToList());
        var sql = "SELECT id, title, description, category, sort_order, created_at, updated_at FROM topics"
            + (topicId is null ? "" : " WHERE id = $id")
            + " ORDER BY sort_order, id";
        using var cmd = Command(conn, sql, topicId is null ? [] : [("$id", topicId)]);
        using var r = cmd.ExecuteReader();
        var list = new List<TopicDto>();
        while (r.Read())
        {
            var id = r.GetInt64(0);
            list.Add(new TopicDto(id, r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4),
                r.GetString(5), r.GetString(6), tasksByTopic.GetValueOrDefault(id) ?? []));
        }
        return list;
    }

    private static TopicDto GetTopic(SqliteConnection conn, long topicId) =>
        ReadTopics(conn, topicId).FirstOrDefault() ?? throw new NotFoundException($"Topic {topicId} not found");

    /// <summary>All topics in a project, each with its tasks.</summary>
    public List<TopicDto> ListTopics(long projectId)
    {
        using var conn = OpenProject(projectId);
        return ReadTopics(conn, null);
    }

    public TopicDto CreateTopic(long projectId, string title, string? description, string? category)
    {
        title = RequireName(title, "Topic title");
        var cat = RequireCategory(category ?? "BACKLOG");
        using var conn = OpenProject(projectId);
        var now = Now();
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM topics WHERE category = $c", ("$c", cat)));
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO topics (title, description, category, sort_order, created_at, updated_at) VALUES ($t, $d, $c, $s, $n, $n) RETURNING id",
            ("$t", title), ("$d", description ?? ""), ("$c", cat), ("$s", sort), ("$n", now)));
        TouchProject(projectId);
        return GetTopic(conn, id);
    }

    public TopicDto UpdateTopic(long projectId, long topicId, string? title, string? description, string? category, long? sortOrder)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        var sets = new List<string>();
        var args = new List<(string, object?)> { ("$id", topicId), ("$u", Now()) };
        if (title is not null) { sets.Add("title = $t"); args.Add(("$t", RequireName(title, "Topic title"))); }
        if (description is not null) { sets.Add("description = $d"); args.Add(("$d", description)); }
        if (category is not null) { sets.Add("category = $c"); args.Add(("$c", RequireCategory(category))); }
        if (sortOrder is not null) { sets.Add("sort_order = $s"); args.Add(("$s", sortOrder)); }
        if (sets.Count > 0)
        {
            sets.Add("updated_at = $u");
            Exec(conn, $"UPDATE topics SET {string.Join(", ", sets)} WHERE id = $id", [.. args]);
            TouchProject(projectId);
        }
        return GetTopic(conn, topicId);
    }

    public void DeleteTopic(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        Exec(conn, "DELETE FROM topics WHERE id = $id", ("$id", topicId));
        TouchProject(projectId);
    }

    /// <summary>Moves the listed topics into a category with sort_order 0..n-1 (used by drag and drop).</summary>
    public List<TopicDto> ReorderTopics(long projectId, string category, IReadOnlyList<long> topicIds)
    {
        var cat = RequireCategory(category);
        using var conn = OpenProject(projectId);
        using (var tx = conn.BeginTransaction())
        {
            var now = Now();
            for (int i = 0; i < topicIds.Count; i++)
            {
                GetTopic(conn, topicIds[i]);
                Exec(conn, "UPDATE topics SET category = $c, sort_order = $s, updated_at = CASE WHEN category = $c THEN updated_at ELSE $u END WHERE id = $id",
                    ("$c", cat), ("$s", i), ("$u", now), ("$id", topicIds[i]));
            }
            tx.Commit();
        }
        TouchProject(projectId);
        return ReadTopics(conn, null);
    }

    /// <summary>Sets sort_order 0..n-1 for the listed tasks of one topic.</summary>
    public List<TaskDto> ReorderTasks(long projectId, long topicId, IReadOnlyList<long> taskIds)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        using (var tx = conn.BeginTransaction())
        {
            for (int i = 0; i < taskIds.Count; i++)
            {
                if (GetTask(conn, taskIds[i]).TopicId != topicId)
                    throw new ArgumentException($"Task {taskIds[i]} doesn't belong to topic {topicId}");
                Exec(conn, "UPDATE tasks SET sort_order = $s WHERE id = $id", ("$s", i), ("$id", taskIds[i]));
            }
            tx.Commit();
        }
        TouchProject(projectId);
        return ReadTasks(conn, topicId);
    }

    public List<TaskDto> ListTasks(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        return ReadTasks(conn, topicId);
    }

    private static TaskDto GetTask(SqliteConnection conn, long taskId)
    {
        using var cmd = Command(conn, "SELECT id, topic_id, title, completed, sort_order, created_at, completed_at FROM tasks WHERE id = $id", [("$id", taskId)]);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Task {taskId} not found");
        return new TaskDto(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3) != 0,
            r.GetInt64(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6));
    }

    public TaskDto AddTask(long projectId, long topicId, string title)
    {
        title = RequireName(title, "Task title");
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE topic_id = $t", ("$t", topicId)));
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO tasks (topic_id, title, sort_order, created_at) VALUES ($t, $title, $s, $c) RETURNING id",
            ("$t", topicId), ("$title", title), ("$s", sort), ("$c", Now())));
        TouchProject(projectId);
        return GetTask(conn, id);
    }

    public TaskDto UpdateTask(long projectId, long taskId, string? title, bool? completed, long? sortOrder)
    {
        using var conn = OpenProject(projectId);
        var task = GetTask(conn, taskId);
        if (title is not null)
            Exec(conn, "UPDATE tasks SET title = $t WHERE id = $id", ("$t", RequireName(title, "Task title")), ("$id", taskId));
        if (completed is not null && completed != task.Completed)
            Exec(conn, "UPDATE tasks SET completed = $c, completed_at = $at WHERE id = $id",
                ("$c", completed.Value ? 1 : 0), ("$at", completed.Value ? Now() : null), ("$id", taskId));
        if (sortOrder is not null)
            Exec(conn, "UPDATE tasks SET sort_order = $s WHERE id = $id", ("$s", sortOrder), ("$id", taskId));
        TouchProject(projectId);
        return GetTask(conn, taskId);
    }

    public void DeleteTask(long projectId, long taskId)
    {
        using var conn = OpenProject(projectId);
        GetTask(conn, taskId);
        Exec(conn, "DELETE FROM tasks WHERE id = $id", ("$id", taskId));
        TouchProject(projectId);
    }
}

public partial class Storage
{
    /// <summary>Case-insensitive substring search over topic titles/descriptions and task titles in every project.</summary>
    public List<SearchHit> Search(string query, int limit = 50)
    {
        query = query.Trim();
        if (query.Length == 0) return [];
        var pattern = "%" + query.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_") + "%";
        var hits = new List<SearchHit>();

        List<(long Id, string Name, string File)> projects = [];
        using (var index = Open(IndexPath))
        using (var cmd = Command(index, "SELECT id, name, file_name FROM projects ORDER BY updated_at DESC", []))
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read()) projects.Add((r.GetInt64(0), r.GetString(1), r.GetString(2)));
        }

        foreach (var (pid, pname, file) in projects)
        {
            var path = Path.Combine(ProjectsDir, file);
            if (!File.Exists(path)) continue;
            using var conn = Open(path);
            const string sql = """
                SELECT t.id, t.title, t.category,
                       CASE WHEN t.title LIKE $q ESCAPE '\' THEN 'title'
                            WHEN t.description LIKE $q ESCAPE '\' THEN 'description'
                            ELSE 'task' END,
                       CASE WHEN t.title LIKE $q ESCAPE '\' THEN t.title
                            WHEN t.description LIKE $q ESCAPE '\' THEN t.description
                            ELSE (SELECT k.title FROM tasks k WHERE k.topic_id = t.id AND k.title LIKE $q ESCAPE '\' ORDER BY k.sort_order LIMIT 1) END
                FROM topics t
                WHERE t.title LIKE $q ESCAPE '\' OR t.description LIKE $q ESCAPE '\'
                   OR EXISTS (SELECT 1 FROM tasks k WHERE k.topic_id = t.id AND k.title LIKE $q ESCAPE '\')
                ORDER BY CASE WHEN t.title LIKE $q ESCAPE '\' THEN 0 ELSE 1 END, t.updated_at DESC
                LIMIT $limit
                """;
            using var cmd = Command(conn, sql, [("$q", pattern), ("$limit", limit - hits.Count)]);
            using var r = cmd.ExecuteReader();
            while (r.Read())
                hits.Add(new SearchHit(pid, pname, r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), Snippet(r.IsDBNull(4) ? "" : r.GetString(4), query)));
            if (hits.Count >= limit) break;
        }
        return hits;
    }

    private static string Snippet(string text, string query)
    {
        text = text.ReplaceLineEndings(" ");
        if (text.Length <= 140) return text;
        var at = Math.Max(0, text.IndexOf(query, StringComparison.OrdinalIgnoreCase));
        var start = Math.Max(0, at - 50);
        var len = Math.Min(140, text.Length - start);
        return (start > 0 ? "…" : "") + text.Substring(start, len) + (start + len < text.Length ? "…" : "");
    }

    /// <summary>Consistent copies of every database via VACUUM INTO (safe while in use).</summary>
    public string BackupTo(string folder)
    {
        Directory.CreateDirectory(Path.Combine(folder, "projects"));
        using (var index = Open(IndexPath))
            Exec(index, "VACUUM INTO $dst", ("$dst", Path.Combine(folder, "index.db")));
        foreach (var file in Directory.EnumerateFiles(ProjectsDir, "*.db"))
        {
            using var conn = Open(file);
            Exec(conn, "VACUUM INTO $dst", ("$dst", Path.Combine(folder, "projects", Path.GetFileName(file))));
        }
        return folder;
    }
}

/// <summary>Distinguishes "field absent" from "field explicitly null" in PATCH bodies.</summary>
public readonly record struct Optional<T>(bool HasValue, T Value)
{
    public static Optional<T> None => default;
    public static Optional<T> Some(T value) => new(true, value);
}
