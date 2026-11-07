using Microsoft.Data.Sqlite;

namespace Bishop;

public record FolderDto(long Id, string Name, long? ParentId, long SortOrder, string CreatedAt);

/// <param name="FolderId">Sidebar folder (grouping), not a disk path.</param>
/// <param name="FolderPath">The project's working folder on disk (holds AGENTS.md); null for projects created before it existed.</param>
/// <param name="FolderMissing">FolderPath is set but the folder no longer exists (moved or deleted).</param>
/// <param name="ClaudeModel">The model saved for Claude on this project. Null: nothing saved. Empty: the CLI's own default. The same goes for the three after it.</param>
/// <param name="AiService">The AI service saved on this project, claude or antigravity. Null: nothing saved.</param>
/// <param name="ProjectType">agent (the full layout) or personal (categories and simple tasks).</param>
public record ProjectDto(long Id, string Name, long? FolderId, long SortOrder, string CreatedAt, string UpdatedAt, string? Tagline, string? ImageVersion, string? FolderPath, bool FolderMissing, string? Icon, string? IconColor,
    string? ClaudeModel, string? ClaudeEffort, string? AntigravityModel, string? AntigravityEffort, string? AiService, string ProjectType = "agent");

public record ProjectImage(string Mime, byte[] Data);

public record TaskDto(long Id, long TopicId, string Title, bool Completed, long SortOrder, string CreatedAt, string? CompletedAt, bool Queued, bool Prerequisite, int Complexity = 5, string? Reply = null, bool FollowUp = false, string? QueuedAt = null);

public record TopicDto(long Id, string Title, string Description, string Category, long SortOrder, string CreatedAt, string UpdatedAt, string? ArchivedAt, bool SameSession, string ModelFamily, string? ModelOverride, string? EffortOverride, List<TaskDto> Tasks);

public record TreeDto(List<FolderDto> Folders, List<ProjectDto> Projects);

/// <param name="Key">What topics store. The defaults have readable keys; added categories get a generated one.</param>
public record CategoryDto(string Key, string Name);

/// <summary>A project's categories and topics after one was removed, since its topics moved.</summary>
public record CategoryRemoval(List<CategoryDto> Categories, List<TopicDto> Topics);

/// <summary>How many open tasks in a project wait their turn.</summary>
public record QueuedCount(long ProjectId, long Count);

/// <summary>One finished task's saved metrics (a row of task_metrics), tagged with its project.</summary>
/// <summary>A saved Terminal session. Times are UTC ISO strings.</summary>
public record SessionRecord(string Id, string Kind, string Title, long? TopicId, long? TaskId, string? TaskTitle, string? Model, string? Effort, string StartedAt, string LastActivityAt, string? EndedAt);

public record TaskMetric(
    long ProjectId, string ProjectName, long TaskId, long? TopicId, string TaskTitle, string Cli, string? Model, string? Effort,
    string? StartedAt, string CompletedAt, double? DurationSeconds,
    long? InputTokens, long? OutputTokens, long? CacheReadTokens, long? CacheCreationTokens, long? Messages);

public record SearchHit(long ProjectId, string ProjectName, long TopicId, string TopicTitle, string Category, string CategoryName, string MatchKind, string Snippet, bool Archived);

/// <summary>Thrown for missing rows; mapped to HTTP 404.</summary>
public class NotFoundException(string message) : Exception(message);

/// <summary>
/// SQLite-backed storage. Layout under the data root:
///   index.db            folders + projects tree
///   projects/{n}.db     one database per project (topics + tasks)
///   context/{n}/        one Markdown file per topic (see TopicContext)
///   trash/              deleted project databases and context files (moved, not destroyed)
/// </summary>
public partial class Storage
{
    /// <summary>The categories a project starts with. After that, each project's own list is in its categories table.</summary>
    private static readonly (string Key, string Name)[] DefaultCategories =
        [("RIGHT_NOW", "Right now"), ("SOON", "Soon"), ("LATER", "Later"), ("BACKLOG", "Backlog")];
    private const string VoiceCategory = "SOON";
    public const int MaxCategoryNameLength = 40;

    private const int IndexSchemaVersion = 8;
    public const int MaxTaglineLength = 200;
    private const int ProjectSchemaVersion = 17;

    public string DataRoot { get; }
    private string IndexPath => Path.Combine(DataRoot, "index.db");
    private string ProjectsDir => Path.Combine(DataRoot, "projects");

    /// <summary>Keeps a poll of every project file from running while a deleted project's file moves to trash.</summary>
    private readonly object _projectFilesGate = new();
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

        // v1: folders + projects tree.
        if (version < 1)
        {
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
            PRAGMA user_version = 1;
            """);
        }

        // v2: optional project tagline. Adding a nullable column keeps existing rows intact.
        if (version < 2)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "tagline"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN tagline TEXT NULL");
            Exec(conn, "PRAGMA user_version = 2");
            tx.Commit();
        }

        // v3: image_version marks that the project has a picture and busts browser caches.
        if (version < 3)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "image_version"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN image_version TEXT NULL");
            Exec(conn, "PRAGMA user_version = 3");
            tx.Commit();
        }

        // v4: the project's working folder on disk. Existing projects get NULL and are asked to link one.
        if (version < 4)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "folder_path"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN folder_path TEXT NULL");
            Exec(conn, "PRAGMA user_version = 4");
            tx.Commit();
        }

        // v5: custom project icon and tint. NULL keeps the default notebook icon.
        if (version < 5)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "icon"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN icon TEXT NULL");
            if (!HasColumn(conn, "projects", "icon_color"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN icon_color TEXT NULL");
            Exec(conn, "PRAGMA user_version = 5");
            tx.Commit();
        }

        // v6: the project's model and reasoning level for each CLI. Their models differ, so each keeps its own pair.
        if (version < 6)
        {
            using var tx = conn.BeginTransaction();
            foreach (var column in new[] { "claude_model", "claude_effort", "antigravity_model", "antigravity_effort" })
            {
                if (!HasColumn(conn, "projects", column))
                    Exec(conn, $"ALTER TABLE projects ADD COLUMN {column} TEXT NULL");
            }
            Exec(conn, "PRAGMA user_version = 6");
            tx.Commit();
        }

        // v7: the project's AI service. NULL: nothing saved, so the project follows the last one chosen.
        if (version < 7)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "ai_service"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN ai_service TEXT NULL");
            Exec(conn, "PRAGMA user_version = 7");
            tx.Commit();
        }

        // v8: the project type. 'agent' is the full layout with topics and Terminal; 'personal' is a plain
        // list of categories and tasks. Existing projects get 'agent', so nothing changes for them.
        if (version < 8)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "projects", "project_type"))
                Exec(conn, "ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'agent' CHECK (project_type IN ('agent', 'personal'))");
            Exec(conn, "PRAGMA user_version = 8");
            tx.Commit();
        }
    }

    private static bool HasColumn(SqliteConnection conn, string table, string column)
    {
        using var cmd = Command(conn, $"SELECT 1 FROM pragma_table_info('{table}') WHERE name = $c", [("$c", column)]);
        return cmd.ExecuteScalar() is not null;
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
        using (var cmd = Command(conn, $"SELECT {ProjectColumns} FROM projects ORDER BY sort_order, id", []))
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
                projects.Add(ReadProject(r));
        }
        return new TreeDto(folders, projects);
    }

    private const string ProjectColumns = "id, name, folder_id, sort_order, created_at, updated_at, tagline, image_version, folder_path, icon, icon_color, claude_model, claude_effort, antigravity_model, antigravity_effort, ai_service, project_type";

    private static ProjectDto ReadProject(SqliteDataReader r)
    {
        var folderPath = r.IsDBNull(8) ? null : r.GetString(8);
        return new(r.GetInt64(0), r.GetString(1), NullableLong(r, 2), r.GetInt64(3), r.GetString(4), r.GetString(5),
            r.IsDBNull(6) ? null : r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7),
            folderPath, folderPath is not null && !Directory.Exists(folderPath),
            r.IsDBNull(9) ? null : r.GetString(9), r.IsDBNull(10) ? null : r.GetString(10),
            r.IsDBNull(11) ? null : r.GetString(11), r.IsDBNull(12) ? null : r.GetString(12),
            r.IsDBNull(13) ? null : r.GetString(13), r.IsDBNull(14) ? null : r.GetString(14),
            r.IsDBNull(15) ? null : r.GetString(15), r.GetString(16));
    }

    /// <summary>Null means nothing saved. Empty stays empty: the project chose the CLI's own default.</summary>
    private static string? SavedChoice(string? value, Func<string?, string?> normalize) => value == "" ? "" : normalize(value);

    /// <summary>Empty means nothing saved.</summary>
    private static string? NormalizeAiService(string? service)
    {
        if (string.IsNullOrEmpty(service)) return null;
        return service is "claude" or "antigravity" ? service : throw new ArgumentException("That AI service isn't valid");
    }

    /// <summary>Empty means agent, the default.</summary>
    private static string NormalizeProjectType(string? type)
    {
        if (string.IsNullOrEmpty(type)) return "agent";
        return type is "agent" or "personal" ? type : throw new ArgumentException("Project type must be agent or personal");
    }

    /// <summary>Empty means none. The catalog lives in the frontend, so only the id's shape is checked here.</summary>
    private static string? NormalizeIcon(string? icon)
    {
        if (string.IsNullOrWhiteSpace(icon)) return null;
        if (!System.Text.RegularExpressions.Regex.IsMatch(icon, "^[A-Za-z0-9_-]{1,64}$"))
            throw new ArgumentException("Icon must be an icon id");
        return icon;
    }

    /// <summary>Empty means no tint; anything else must be #rrggbb.</summary>
    private static string? NormalizeIconColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color)) return null;
        if (!System.Text.RegularExpressions.Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$"))
            throw new ArgumentException("Icon color must look like #rrggbb");
        return color.ToLowerInvariant();
    }

    /// <summary>Trims; empty means no tagline; longer than <see cref="MaxTaglineLength"/> is rejected.</summary>
    private static string? NormalizeTagline(string? tagline)
    {
        var t = tagline?.Trim().ReplaceLineEndings(" ");
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > MaxTaglineLength)
            throw new ArgumentException($"Tagline must be at most {MaxTaglineLength} characters (got {t.Length})");
        return t;
    }

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
        using var cmd = Command(conn, $"SELECT {ProjectColumns} FROM projects WHERE id = $id", [("$id", id)]);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Project {id} not found");
        return ReadProject(r);
    }

    public ProjectDto GetProject(long id)
    {
        using var conn = Open(IndexPath);
        return GetProject(conn, id);
    }

    /// <param name="folderPath">Already normalized and prepared by <see cref="ProjectFolders.Link"/>.</param>
    public ProjectDto CreateProject(string name, long? folderId, string? tagline = null, string? folderPath = null, string? projectType = null)
    {
        name = RequireName(name, "Project name");
        projectType = NormalizeProjectType(projectType);
        tagline = NormalizeTagline(tagline);
        using var conn = Open(IndexPath);
        EnsureFolderExists(conn, folderId);
        var now = Now();
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects WHERE folder_id IS $f", ("$f", folderId)));
        var fileName = $"{Guid.NewGuid():N}.db";
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO projects (name, folder_id, file_name, sort_order, created_at, updated_at, tagline, folder_path, project_type) VALUES ($n, $f, $file, $s, $c, $c, $t, $p, $pt) RETURNING id",
            ("$n", name), ("$f", folderId), ("$file", fileName), ("$s", sort), ("$c", now), ("$t", tagline), ("$p", folderPath), ("$pt", projectType)));
        InitProjectDb(Path.Combine(ProjectsDir, fileName));
        return GetProject(conn, id);
    }

    /// <param name="tagline">None = keep; Some(null or blank) = clear.</param>
    /// <param name="folderPath">Relink to this working folder (already prepared by <see cref="ProjectFolders.Link"/>); null keeps it.</param>
    public ProjectDto UpdateProject(long id, string? name, Optional<long?> folderId, Optional<string?> tagline = default, string? folderPath = null,
        Optional<string?> icon = default, Optional<string?> iconColor = default,
        Optional<string?> claudeModel = default, Optional<string?> claudeEffort = default,
        Optional<string?> antigravityModel = default, Optional<string?> antigravityEffort = default, Optional<string?> aiService = default, string? projectType = null)
    {
        using var conn = Open(IndexPath);
        GetProject(conn, id);
        var newType = projectType is null ? null : NormalizeProjectType(projectType);
        // Checked before anything is written, so a bad value saves nothing.
        var choices = new[]
        {
            ("claude_model", claudeModel, SavedChoice(claudeModel.Value, Terminals.NormalizeModel)),
            ("claude_effort", claudeEffort, SavedChoice(claudeEffort.Value, Terminals.NormalizeEffort)),
            ("antigravity_model", antigravityModel, SavedChoice(antigravityModel.Value, Terminals.NormalizeModel)),
            ("antigravity_effort", antigravityEffort, SavedChoice(antigravityEffort.Value, Terminals.NormalizeEffort)),
            ("ai_service", aiService, NormalizeAiService(aiService.Value)),
        };
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
        if (tagline.HasValue)
        {
            Exec(conn, "UPDATE projects SET tagline = $t, updated_at = $u WHERE id = $id",
                ("$t", NormalizeTagline(tagline.Value)), ("$u", Now()), ("$id", id));
        }
        if (folderPath is not null)
        {
            Exec(conn, "UPDATE projects SET folder_path = $p, updated_at = $u WHERE id = $id",
                ("$p", folderPath), ("$u", Now()), ("$id", id));
        }
        if (icon.HasValue)
        {
            Exec(conn, "UPDATE projects SET icon = $i, updated_at = $u WHERE id = $id",
                ("$i", NormalizeIcon(icon.Value)), ("$u", Now()), ("$id", id));
        }
        if (iconColor.HasValue)
        {
            Exec(conn, "UPDATE projects SET icon_color = $c, updated_at = $u WHERE id = $id",
                ("$c", NormalizeIconColor(iconColor.Value)), ("$u", Now()), ("$id", id));
        }
        if (newType is not null)
        {
            Exec(conn, "UPDATE projects SET project_type = $t, updated_at = $u WHERE id = $id",
                ("$t", newType), ("$u", Now()), ("$id", id));
        }
        foreach (var (column, given, value) in choices)
        {
            if (given.HasValue)
                Exec(conn, $"UPDATE projects SET {column} = $v, updated_at = $u WHERE id = $id", ("$v", value), ("$u", Now()), ("$id", id));
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
        lock (_projectFilesGate)
        {
            Exec(conn, "DELETE FROM projects WHERE id = $id", ("$id", id));

            var src = Path.Combine(ProjectsDir, fileName);
            if (File.Exists(src))
            {
                Directory.CreateDirectory(TrashDir);
                var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                File.Move(src, Path.Combine(TrashDir, $"{stamp}-{id}-{fileName}"));
            }
        }
        TrashContext(TopicContext.ProjectDir(DataRoot, id), $"{id}-context");
    }

    /// <summary>Moves a context file or folder to trash. The row is already gone, so a failure is only logged.</summary>
    private void TrashContext(string path, string name)
    {
        try
        {
            var isDir = Directory.Exists(path);
            if (!isDir && !File.Exists(path)) return;
            Directory.CreateDirectory(TrashDir);
            var target = Path.Combine(TrashDir, $"{DateTime.UtcNow:yyyyMMddHHmmss}-{name}");
            if (isDir) Directory.Move(path, target);
            else File.Move(path, target);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Info($"Couldn't move {path} to trash: {ex.Message}");
        }
    }

    // -------------------------------------------------------------- projects

    private static void InitProjectDb(string path)
    {
        using var conn = Open(path);
        var version = Convert.ToInt32(Scalar(conn, "PRAGMA user_version;"));
        if (version >= ProjectSchemaVersion) return;

        // v1: topics + tasks.
        if (version < 1)
        {
        var categoryList = string.Join(",", DefaultCategories.Select(c => $"'{c.Key}'"));
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
            PRAGMA user_version = 1;
            """);
        }

        // v2: optional project picture, stored in the project's own file so it moves
        // with the project (backups, trash).
        if (version < 2)
        {
            Exec(conn, """
                CREATE TABLE IF NOT EXISTS project_image (
                    id          INTEGER PRIMARY KEY CHECK (id = 1),
                    mime        TEXT    NOT NULL,
                    data        BLOB    NOT NULL,
                    updated_at  TEXT    NOT NULL
                );
                PRAGMA user_version = 2;
                """);
        }

        // v3: archived_at hides a topic from the board without deleting it. NULL means not archived.
        if (version < 3)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "topics", "archived_at"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN archived_at TEXT NULL");
            Exec(conn, "PRAGMA user_version = 3");
            tx.Commit();
        }

        // v4: queued marks an open task as waiting its turn. Completing a task clears it.
        if (version < 4)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "queued"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN queued INTEGER NOT NULL DEFAULT 0 CHECK (queued IN (0, 1))");
            Exec(conn, "PRAGMA user_version = 4");
            tx.Commit();
        }

        // v5: same_session makes a topic's tasks share one Claude session. Off means each task gets a new session.
        if (version < 5)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "topics", "same_session"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN same_session INTEGER NOT NULL DEFAULT 0 CHECK (same_session IN (0, 1))");
            Exec(conn, "PRAGMA user_version = 5");
            tx.Commit();
        }

        // v6: claude_session_id is the Claude conversation of the topic's latest task, so same session mode can resume it.
        if (version < 6)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "topics", "claude_session_id"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN claude_session_id TEXT");
            Exec(conn, "PRAGMA user_version = 6");
            tx.Commit();
        }

        // v7: category_names holds the project's custom category names. A category with no row uses its default label.
        if (version < 7)
        {
            var categoryList = string.Join(",", DefaultCategories.Select(c => $"'{c.Key}'"));
            using var tx = conn.BeginTransaction();
            Exec(conn, $"""
                CREATE TABLE IF NOT EXISTS category_names (
                    category  TEXT PRIMARY KEY CHECK (category IN ({categoryList})),
                    name      TEXT NOT NULL
                );
                PRAGMA user_version = 7;
                """);
            tx.Commit();
        }

        // v8: categories holds the project's own list, so categories can be added and removed. Custom names move
        // into it, and topics.category loses its fixed CHECK. The column is swapped rather than the table rebuilt:
        // dropping topics would cascade to tasks.
        if (version < 8)
        {
            using var tx = conn.BeginTransaction();
            Exec(conn, """
                CREATE TABLE IF NOT EXISTS categories (
                    key         TEXT    PRIMARY KEY,
                    name        TEXT    NOT NULL,
                    sort_order  INTEGER NOT NULL
                );
                """);
            for (int i = 0; i < DefaultCategories.Length; i++)
            {
                Exec(conn, "INSERT INTO categories (key, name, sort_order) VALUES ($k, COALESCE((SELECT name FROM category_names WHERE category = $k), $n), $s)",
                    ("$k", DefaultCategories[i].Key), ("$n", DefaultCategories[i].Name), ("$s", i));
            }
            Exec(conn, """
                DROP TABLE category_names;
                DROP INDEX ix_topics_category;
                ALTER TABLE topics ADD COLUMN category_key TEXT NOT NULL DEFAULT 'BACKLOG';
                UPDATE topics SET category_key = category;
                ALTER TABLE topics DROP COLUMN category;
                ALTER TABLE topics RENAME COLUMN category_key TO category;
                CREATE INDEX ix_topics_category ON topics(category, sort_order);
                PRAGMA user_version = 8;
                """);
            tx.Commit();
        }

        // v9: prerequisite marks a task as a user-action prerequisite that must be done before other tasks.
        if (version < 9)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "prerequisite"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN prerequisite INTEGER NOT NULL DEFAULT 0 CHECK (prerequisite IN (0, 1))");
            Exec(conn, """
                CREATE TABLE IF NOT EXISTS prerequisites (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                    title       TEXT    NOT NULL,
                    completed   INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT    NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_prerequisites_topic ON prerequisites(topic_id, sort_order);
                CREATE TRIGGER IF NOT EXISTS trg_tasks_insert_prereq
                AFTER INSERT ON tasks
                WHEN NEW.prerequisite = 1
                BEGIN
                    INSERT OR REPLACE INTO prerequisites (id, topic_id, title, completed, sort_order, created_at)
                    VALUES (NEW.id, NEW.topic_id, NEW.title, NEW.completed, NEW.sort_order, NEW.created_at);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_tasks_update_prereq
                AFTER UPDATE ON tasks
                BEGIN
                    DELETE FROM prerequisites WHERE id = OLD.id;
                    INSERT INTO prerequisites (id, topic_id, title, completed, sort_order, created_at)
                    SELECT NEW.id, NEW.topic_id, NEW.title, NEW.completed, NEW.sort_order, NEW.created_at
                    WHERE NEW.prerequisite = 1;
                END;
                CREATE TRIGGER IF NOT EXISTS trg_tasks_delete_prereq
                AFTER DELETE ON tasks
                BEGIN
                    DELETE FROM prerequisites WHERE id = OLD.id;
                END;
                """);
            Exec(conn, """
                UPDATE tasks
                SET prerequisite = 1
                WHERE lower(title) LIKE '%art asset%'
                   OR lower(title) LIKE '%playtest%'
                   OR lower(title) LIKE '%play-test%'
                   OR lower(title) LIKE '%user testing%'
                   OR lower(title) LIKE '%manual test%'
                   OR lower(title) LIKE '%prerequisite%';
                INSERT OR IGNORE INTO prerequisites (id, topic_id, title, completed, sort_order, created_at)
                SELECT id, topic_id, title, completed, sort_order, created_at
                FROM tasks
                WHERE prerequisite = 1;
                """);
            Exec(conn, "PRAGMA user_version = 9");
            tx.Commit();
        }

        // v10: complexity rates a task from 1 (simple) to 10 (very complex).
        if (version < 10)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "complexity"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN complexity INTEGER NOT NULL DEFAULT 5 CHECK (complexity BETWEEN 1 AND 10)");
            using (var cmd = Command(conn, "SELECT id, title FROM tasks", []))
            using (var r = cmd.ExecuteReader())
            {
                var updates = new List<(long Id, int Complexity)>();
                while (r.Read())
                    updates.Add((r.GetInt64(0), ClaudeCli.RateTaskComplexity(r.GetString(1))));
                r.Close();
                foreach (var (id, c) in updates)
                    Exec(conn, "UPDATE tasks SET complexity = $c WHERE id = $id", ("$c", c), ("$id", id));
            }
            Exec(conn, "PRAGMA user_version = 10");
            tx.Commit();
        }

        // v11: model_family is the family of agent models a topic's tasks are delegated to.
        if (version < 11)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "topics", "model_family"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN model_family TEXT NOT NULL DEFAULT 'claude' CHECK (model_family IN ('claude', 'gemini'))");
            Exec(conn, "PRAGMA user_version = 11");
            tx.Commit();
        }

        // v12: task_metrics keeps what each task Claude finished cost: time, tokens, model and reasoning level.
        // No foreign keys: the numbers outlive a deleted task or topic, so the charts keep their history.
        if (version < 12)
        {
            using var tx = conn.BeginTransaction();
            Exec(conn, """
                CREATE TABLE IF NOT EXISTS task_metrics (
                    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id               INTEGER NOT NULL,
                    topic_id              INTEGER NULL,
                    task_title            TEXT    NOT NULL,
                    cli                   TEXT    NOT NULL,
                    model                 TEXT    NULL,
                    effort                TEXT    NULL,
                    started_at            TEXT    NULL,
                    completed_at          TEXT    NOT NULL,
                    duration_seconds      REAL    NULL,
                    input_tokens          INTEGER NULL,
                    output_tokens         INTEGER NULL,
                    cache_read_tokens     INTEGER NULL,
                    cache_creation_tokens INTEGER NULL,
                    messages              INTEGER NULL
                );
                CREATE INDEX IF NOT EXISTS ix_task_metrics_completed ON task_metrics(completed_at);
                CREATE INDEX IF NOT EXISTS ix_task_metrics_task ON task_metrics(task_id);
                """);
            Exec(conn, "PRAGMA user_version = 12");
            tx.Commit();
        }

        // v13: reply holds the written answer a user types on a user task. NULL means no reply yet.
        if (version < 13)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "reply"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN reply TEXT NULL");
            Exec(conn, "PRAGMA user_version = 13");
            tx.Commit();
        }

        // v14: follow_up marks a user task as a follow-up (done after the agent tasks) instead of a prerequisite.
        if (version < 14)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "follow_up"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0 CHECK (follow_up IN (0, 1))");
            Exec(conn, "PRAGMA user_version = 14");
            tx.Commit();
        }

        // v15: model_override and effort_override let a topic pick its own model and reasoning effort.
        // NULL means no override, so tasks are delegated automatically.
        if (version < 15)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "topics", "model_override"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN model_override TEXT NULL");
            if (!HasColumn(conn, "topics", "effort_override"))
                Exec(conn, "ALTER TABLE topics ADD COLUMN effort_override TEXT NULL");
            Exec(conn, "PRAGMA user_version = 15");
            tx.Commit();
        }

        // v16: queued_at records when a task was queued, so the board can show queued topics in queue order.
        // Tasks already queued get their creation time, which keeps their current relative order.
        if (version < 16)
        {
            using var tx = conn.BeginTransaction();
            if (!HasColumn(conn, "tasks", "queued_at"))
                Exec(conn, "ALTER TABLE tasks ADD COLUMN queued_at TEXT NULL");
            Exec(conn, "UPDATE tasks SET queued_at = created_at WHERE queued = 1 AND queued_at IS NULL");
            Exec(conn, "PRAGMA user_version = 16");
            tx.Commit();
        }

        // v17: sessions keeps a record of each Terminal session and when it last did something, so the
        // sessions panel can list the past week's sessions after a restart. Times are UTC ISO strings.
        if (version < 17)
        {
            using var tx = conn.BeginTransaction();
            Exec(conn, """
                CREATE TABLE IF NOT EXISTS sessions (
                    id               TEXT    PRIMARY KEY,
                    kind             TEXT    NOT NULL,
                    title            TEXT    NOT NULL DEFAULT '',
                    topic_id         INTEGER NULL,
                    task_id          INTEGER NULL,
                    task_title       TEXT    NULL,
                    model            TEXT    NULL,
                    effort           TEXT    NULL,
                    started_at       TEXT    NOT NULL,
                    last_activity_at TEXT    NOT NULL,
                    ended_at         TEXT    NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
                """);
            Exec(conn, "PRAGMA user_version = 17");
            tx.Commit();
        }
    }

    /// <summary>Saves the metrics of a task Claude just finished. A failure is logged and never blocks ticking the task.</summary>
    public void RecordTaskMetrics(TaskCompletion c, long? topicId, string cli)
    {
        try
        {
            using var conn = OpenProject(c.ProjectId);
            var t = c.Tokens;
            Exec(conn, """
                INSERT INTO task_metrics (task_id, topic_id, task_title, cli, model, effort, started_at, completed_at, duration_seconds,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, messages)
                VALUES ($task, $topic, $title, $cli, $model, $effort, $start, $done, $dur, $in, $out, $cr, $cc, $msgs)
                """,
                ("$task", c.TaskId), ("$topic", topicId), ("$title", c.TaskTitle), ("$cli", cli), ("$model", c.Model), ("$effort", c.Effort),
                ("$start", c.StartedAt?.UtcDateTime.ToString("o")), ("$done", Now()), ("$dur", c.Duration?.TotalSeconds),
                ("$in", t?.Input), ("$out", t?.Output), ("$cr", t?.CacheRead), ("$cc", t?.CacheCreation), ("$msgs", t?.Messages));
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't save metrics for task {c.TaskId}: {ex.Message}");
        }
    }

    /// <summary>Saves a Terminal session's record (insert, or update when it exists). A failure is logged and never blocks the session.</summary>
    public void SaveSession(TerminalInfo s, DateTimeOffset startedAt)
    {
        try
        {
            using var conn = OpenProject(s.ProjectId);
            Exec(conn, """
                INSERT INTO sessions (id, kind, title, topic_id, task_id, task_title, model, effort, started_at, last_activity_at, ended_at)
                VALUES ($id, $kind, $title, $topic, $task, $taskTitle, $model, $effort, $start, $last, $ended)
                ON CONFLICT(id) DO UPDATE SET title = $title, topic_id = $topic, task_id = $task, task_title = $taskTitle,
                    last_activity_at = $last, ended_at = $ended
                """,
                ("$id", s.Id), ("$kind", s.Kind), ("$title", s.Title), ("$topic", s.TopicId), ("$task", s.TaskId), ("$taskTitle", s.TaskTitle),
                ("$model", s.Model), ("$effort", s.Effort), ("$start", startedAt.UtcDateTime.ToString("o")),
                ("$last", s.LastActivityAt.UtcDateTime.ToString("o")), ("$ended", s.EndedAt?.UtcDateTime.ToString("o")));
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't save session {s.Id}: {ex.Message}");
        }
    }

    /// <summary>Sessions of a project whose last activity falls in the past <paramref name="days"/> days, most recent first.</summary>
    public List<SessionRecord> ListRecentSessions(long projectId, int days = 7)
    {
        var since = DateTime.UtcNow.AddDays(-days).ToString("o");
        using var conn = OpenProject(projectId);
        using var cmd = Command(conn, """
            SELECT id, kind, title, topic_id, task_id, task_title, model, effort, started_at, last_activity_at, ended_at
            FROM sessions WHERE last_activity_at >= $since ORDER BY last_activity_at DESC
            """, [("$since", since)]);
        using var r = cmd.ExecuteReader();
        var rows = new List<SessionRecord>();
        while (r.Read())
        {
            string? Str(int i) => r.IsDBNull(i) ? null : r.GetString(i);
            rows.Add(new SessionRecord(r.GetString(0), r.GetString(1), r.GetString(2), NullableLong(r, 3), NullableLong(r, 4), Str(5),
                Str(6), Str(7), r.GetString(8), r.GetString(9), Str(10)));
        }
        return rows;
    }

    public ProjectImage GetProjectImage(long projectId)
    {
        using var conn = OpenProject(projectId);
        using var cmd = Command(conn, "SELECT mime, data FROM project_image WHERE id = 1", []);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Project {projectId} has no picture");
        return new ProjectImage(r.GetString(0), (byte[])r["data"]);
    }

    /// <summary>Stores (replaces) the project picture; returns the updated project.</summary>
    public ProjectDto SetProjectImage(long projectId, ProjectImage image)
    {
        var now = Now();
        using (var conn = OpenProject(projectId))
        {
            Exec(conn, """
                INSERT INTO project_image (id, mime, data, updated_at) VALUES (1, $m, $d, $u)
                ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at
                """, ("$m", image.Mime), ("$d", image.Data), ("$u", now));
        }
        using var index = Open(IndexPath);
        Exec(index, "UPDATE projects SET image_version = $v, updated_at = $v WHERE id = $id", ("$v", now), ("$id", projectId));
        return GetProject(index, projectId);
    }

    public ProjectDto DeleteProjectImage(long projectId)
    {
        using (var conn = OpenProject(projectId))
            Exec(conn, "DELETE FROM project_image");
        using var index = Open(IndexPath);
        Exec(index, "UPDATE projects SET image_version = NULL, updated_at = $u WHERE id = $id", ("$u", Now()), ("$id", projectId));
        return GetProject(index, projectId);
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

    private static string RequireCategory(SqliteConnection conn, string? category)
    {
        var c = category?.Trim().ToUpperInvariant();
        if (c is null || Scalar(conn, "SELECT 1 FROM categories WHERE key = $k", ("$k", c)) is null)
            throw new ArgumentException($"This project has no category \"{category}\"");
        return c;
    }

    private static List<TaskDto> ReadTasks(SqliteConnection conn, long? topicId)
    {
        var sql = "SELECT id, topic_id, title, completed, sort_order, created_at, completed_at, queued, prerequisite, complexity, reply, follow_up, queued_at FROM tasks"
            + (topicId is null ? "" : " WHERE topic_id = $t")
            + " ORDER BY sort_order, id";
        using var cmd = Command(conn, sql, topicId is null ? [] : [("$t", topicId)]);
        using var r = cmd.ExecuteReader();
        var list = new List<TaskDto>();
        while (r.Read())
        {
            var title = r.GetString(2);
            var complexity = r.IsDBNull(9) ? ClaudeCli.RateTaskComplexity(title) : Math.Clamp(r.GetInt32(9), 1, 10);
            list.Add(new TaskDto(r.GetInt64(0), r.GetInt64(1), title, r.GetInt64(3) != 0,
                r.GetInt64(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6), r.GetInt64(7) != 0, r.GetInt64(8) != 0, complexity, r.IsDBNull(10) ? null : r.GetString(10), r.GetInt64(11) != 0, r.IsDBNull(12) ? null : r.GetString(12)));
        }
        return list;
    }

    private static List<TopicDto> ReadTopics(SqliteConnection conn, long? topicId)
    {
        var tasksByTopic = ReadTasks(conn, topicId).GroupBy(t => t.TopicId).ToDictionary(g => g.Key, g => g.ToList());
        var sql = "SELECT id, title, description, category, sort_order, created_at, updated_at, archived_at, same_session, model_family, model_override, effort_override FROM topics"
            + (topicId is null ? "" : " WHERE id = $id")
            + " ORDER BY sort_order, id";
        using var cmd = Command(conn, sql, topicId is null ? [] : [("$id", topicId)]);
        using var r = cmd.ExecuteReader();
        var list = new List<TopicDto>();
        while (r.Read())
        {
            var id = r.GetInt64(0);
            list.Add(new TopicDto(id, r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4),
                r.GetString(5), r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.GetInt64(8) != 0, r.GetString(9),
                r.IsDBNull(10) ? null : r.GetString(10), r.IsDBNull(11) ? null : r.GetString(11), tasksByTopic.GetValueOrDefault(id) ?? []));
        }
        return list;
    }

    private static TopicDto GetTopic(SqliteConnection conn, long topicId) =>
        ReadTopics(conn, topicId).FirstOrDefault() ?? throw new NotFoundException($"Topic {topicId} not found");

    /// <summary>One topic in a project, with its tasks.</summary>
    public TopicDto GetTopic(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        return GetTopic(conn, topicId);
    }

    /// <summary>All topics in a project, each with its tasks.</summary>
    public List<TopicDto> ListTopics(long projectId)
    {
        using var conn = OpenProject(projectId);
        return ReadTopics(conn, null);
    }

    /// <summary>The project's categories, in board order. A project always has at least one.</summary>
    public List<CategoryDto> GetCategories(long projectId)
    {
        using var conn = OpenProject(projectId);
        return ReadCategories(conn);
    }

    /// <summary>Where a new voice topic starts: Soon, or the first category if the project removed Soon.</summary>
    public string GetVoiceCategory(long projectId)
    {
        var categories = GetCategories(projectId);
        return categories.Any(c => c.Key == VoiceCategory) ? VoiceCategory : categories[0].Key;
    }

    /// <summary>Adds a category at the end of the board; returns all of the project's categories.</summary>
    public List<CategoryDto> AddCategory(long projectId, string? name)
    {
        var trimmed = RequireCategoryName(name);
        using var conn = OpenProject(projectId);
        Exec(conn, "INSERT INTO categories (key, name, sort_order) VALUES ($k, $n, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories))",
            ("$k", $"C_{Guid.NewGuid():N}".ToUpperInvariant()), ("$n", trimmed));
        TouchProject(projectId);
        return ReadCategories(conn);
    }

    /// <summary>Renames one category; returns all of the project's categories.</summary>
    public List<CategoryDto> RenameCategory(long projectId, string? category, string? name)
    {
        var trimmed = RequireCategoryName(name);
        using var conn = OpenProject(projectId);
        Exec(conn, "UPDATE categories SET name = $n WHERE key = $k", ("$n", trimmed), ("$k", RequireCategory(conn, category)));
        TouchProject(projectId);
        return ReadCategories(conn);
    }

    /// <summary>
    /// Removes a category. Its topics, archived ones too, go to the end of <paramref name="moveTo"/>, so no topic is ever
    /// left without a category. Only a category with no topics can leave moveTo out.
    /// </summary>
    public CategoryRemoval RemoveCategory(long projectId, string? category, string? moveTo)
    {
        using var conn = OpenProject(projectId);
        var cat = RequireCategory(conn, category);
        if (ReadCategories(conn).Count == 1)
            throw new ApiProblem(409, "last_category", "A project needs at least one category.");

        using (var tx = conn.BeginTransaction())
        {
            var ids = ReadTopics(conn, null).Where(t => t.Category == cat).Select(t => t.Id).ToList();
            if (ids.Count > 0)
            {
                if (moveTo is null)
                    throw new ApiProblem(409, "category_not_empty", "This category has topics. Choose a category to move them to.");
                var target = RequireCategory(conn, moveTo);
                if (target == cat) throw new ArgumentException("Topics can't move to the category being removed");
                var offset = Convert.ToInt64(Scalar(conn, "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM topics WHERE category = $c", ("$c", target)));
                var now = Now();
                for (int i = 0; i < ids.Count; i++)
                {
                    Exec(conn, "UPDATE topics SET category = $c, sort_order = $s, updated_at = $u WHERE id = $id",
                        ("$c", target), ("$s", offset + i), ("$u", now), ("$id", ids[i]));
                }
            }
            Exec(conn, "DELETE FROM categories WHERE key = $k", ("$k", cat));
            tx.Commit();
        }
        TouchProject(projectId);
        return new CategoryRemoval(ReadCategories(conn), ReadTopics(conn, null));
    }

    private static string RequireCategoryName(string? name)
    {
        var trimmed = RequireName(name, "Category name");
        if (trimmed.Length > MaxCategoryNameLength)
            throw new ArgumentException($"Category name must be at most {MaxCategoryNameLength} characters");
        return trimmed;
    }

    private static List<CategoryDto> ReadCategories(SqliteConnection conn)
    {
        using var cmd = Command(conn, "SELECT key, name FROM categories ORDER BY sort_order, key", []);
        using var r = cmd.ExecuteReader();
        var list = new List<CategoryDto>();
        while (r.Read()) list.Add(new CategoryDto(r.GetString(0), r.GetString(1)));
        return list;
    }

    public TopicDto CreateTopic(long projectId, string title, string? description, string? category)
    {
        title = RequireName(title, "Topic title");
        using var conn = OpenProject(projectId);
        // With no category given, the topic goes in the last one: Backlog, unless the project changed its list.
        var cat = category is null ? ReadCategories(conn)[^1].Key : RequireCategory(conn, category);
        var now = Now();
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM topics WHERE category = $c", ("$c", cat)));
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO topics (title, description, category, sort_order, created_at, updated_at) VALUES ($t, $d, $c, $s, $n, $n) RETURNING id",
            ("$t", title), ("$d", description ?? ""), ("$c", cat), ("$s", sort), ("$n", now)));
        TouchProject(projectId);
        return GetTopic(conn, id);
    }

    /// <summary>A model id can reach a CLI command line, so it stays plain. The list of models varies by CLI, so it isn't checked against one.</summary>
    private static readonly System.Text.RegularExpressions.Regex OverrideModelId = new(@"^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,99}$");

    public TopicDto UpdateTopic(long projectId, long topicId, string? title, string? description, string? category, long? sortOrder, bool? archived, bool? sameSession, string? modelFamily = null,
        Optional<string?> modelOverride = default, Optional<string?> effortOverride = default)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        var sets = new List<string>();
        var args = new List<(string, object?)> { ("$id", topicId), ("$u", Now()) };
        if (title is not null) { sets.Add("title = $t"); args.Add(("$t", RequireName(title, "Topic title"))); }
        if (description is not null) { sets.Add("description = $d"); args.Add(("$d", description)); }
        if (category is not null) { sets.Add("category = $c"); args.Add(("$c", RequireCategory(conn, category))); }
        if (sortOrder is not null) { sets.Add("sort_order = $s"); args.Add(("$s", sortOrder)); }
        // Archiving twice keeps the first date.
        if (archived is not null) sets.Add(archived.Value ? "archived_at = COALESCE(archived_at, $u)" : "archived_at = NULL");
        if (sameSession is not null) { sets.Add("same_session = $ss"); args.Add(("$ss", sameSession.Value ? 1 : 0)); }
        if (modelFamily is not null)
        {
            var family = modelFamily.Trim().ToLowerInvariant();
            if (family is not ("claude" or "gemini"))
                throw new ArgumentException($"Unknown model family \"{modelFamily}\". Use \"claude\" or \"gemini\".");
            sets.Add("model_family = $mf");
            args.Add(("$mf", family));
        }
        // null or an empty string clears the override: tasks go back to automatic delegation.
        if (modelOverride.HasValue)
        {
            var model = modelOverride.Value?.Trim();
            if (string.IsNullOrEmpty(model)) model = null;
            else if (!OverrideModelId.IsMatch(model))
                throw new ArgumentException($"Invalid model \"{model}\". Use a plain model id such as \"opus\".");
            sets.Add("model_override = $mo");
            args.Add(("$mo", model));
        }
        if (effortOverride.HasValue)
        {
            var effort = effortOverride.Value?.Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(effort)) effort = null;
            else if (!Terminals.EffortLevels.Contains(effort))
                throw new ArgumentException($"Unknown effort \"{effortOverride.Value}\". Use {string.Join(", ", Terminals.EffortLevels)}.");
            sets.Add("effort_override = $eo");
            args.Add(("$eo", effort));
        }
        if (sets.Count > 0)
        {
            sets.Add("updated_at = $u");
            Exec(conn, $"UPDATE topics SET {string.Join(", ", sets)} WHERE id = $id", [.. args]);
            TouchProject(projectId);
        }
        return GetTopic(conn, topicId);
    }

    /// <summary>The Claude conversation of the topic's latest task, if it has had one.</summary>
    public string? GetTopicClaudeSession(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        using var cmd = Command(conn, "SELECT claude_session_id FROM topics WHERE id = $id", [("$id", topicId)]);
        return cmd.ExecuteScalar() as string;
    }

    /// <summary>Bishop's own bookkeeping, not an edit by the user, so the topic's updated date stays.</summary>
    public void SetTopicClaudeSession(long projectId, long topicId, string claudeSessionId)
    {
        using var conn = OpenProject(projectId);
        Exec(conn, "UPDATE topics SET claude_session_id = $c WHERE id = $id", ("$c", claudeSessionId), ("$id", topicId));
    }

    public void DeleteTopic(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        Exec(conn, "DELETE FROM topics WHERE id = $id", ("$id", topicId));
        TouchProject(projectId);
        TrashContext(TopicContext.FilePath(DataRoot, projectId, topicId), $"{projectId}-topic-{topicId}-context.md");
    }

    /// <summary>
    /// Moves a topic and its tasks to another project and returns it as it is there, with new ids. It keeps its
    /// category when the destination has one with the same key, otherwise it goes in <paramref name="category"/>,
    /// or the destination's last category. It goes at the end of that category. The destination is written first,
    /// so a failure part way leaves a copy, never a lost topic. The Claude session id stays behind: that conversation
    /// ran in the other project's folder. Task metrics stay with the source project's history.
    /// </summary>
    public TopicDto MoveTopic(long projectId, long topicId, long toProjectId, string? category)
    {
        if (toProjectId == projectId)
            throw new ApiProblem(409, "same_project", "The topic is already in this project.");
        using var source = OpenProject(projectId);
        var topic = GetTopic(source, topicId);
        using var dest = OpenProject(toProjectId);

        var keys = ReadCategories(dest).Select(c => c.Key).ToHashSet();
        var cat = category is not null ? RequireCategory(dest, category)
            : keys.Contains(topic.Category) ? topic.Category
            : ReadCategories(dest)[^1].Key;

        long newId;
        using (var tx = dest.BeginTransaction())
        {
            var sort = Convert.ToInt64(Scalar(dest,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM topics WHERE category = $c", ("$c", cat)));
            newId = Convert.ToInt64(Scalar(dest, """
                INSERT INTO topics (title, description, category, sort_order, created_at, updated_at, archived_at, same_session, model_family, model_override, effort_override)
                VALUES ($t, $d, $c, $s, $cr, $u, $a, $ss, $mf, $mo, $eo) RETURNING id
                """,
                ("$t", topic.Title), ("$d", topic.Description), ("$c", cat), ("$s", sort), ("$cr", topic.CreatedAt),
                ("$u", Now()), ("$a", topic.ArchivedAt), ("$ss", topic.SameSession ? 1 : 0), ("$mf", topic.ModelFamily),
                ("$mo", topic.ModelOverride), ("$eo", topic.EffortOverride)));
            foreach (var t in topic.Tasks)
            {
                Exec(dest, """
                    INSERT INTO tasks (topic_id, title, completed, sort_order, created_at, completed_at, queued, prerequisite, complexity, reply, follow_up, queued_at)
                    VALUES ($tid, $title, $done, $s, $cr, $ca, $q, $p, $cx, $r, $f, $qa)
                    """,
                    ("$tid", newId), ("$title", t.Title), ("$done", t.Completed ? 1 : 0), ("$s", t.SortOrder), ("$cr", t.CreatedAt),
                    ("$ca", t.CompletedAt), ("$q", t.Queued ? 1 : 0), ("$p", t.Prerequisite ? 1 : 0), ("$cx", t.Complexity),
                    ("$r", t.Reply), ("$f", t.FollowUp ? 1 : 0), ("$qa", t.QueuedAt));
            }
            tx.Commit();
        }

        Exec(source, "DELETE FROM topics WHERE id = $id", ("$id", topicId));
        TouchProject(projectId);
        TouchProject(toProjectId);
        MoveContextFile(projectId, topicId, toProjectId, newId);
        return GetTopic(dest, newId);
    }

    /// <summary>
    /// Moves the topic's context file to the new project and topic id. Never overwrites: if a file is already at
    /// the target, the old one goes to trash. A failure is logged and doesn't fail the move.
    /// </summary>
    private void MoveContextFile(long fromProjectId, long fromTopicId, long toProjectId, long toTopicId)
    {
        var from = TopicContext.FilePath(DataRoot, fromProjectId, fromTopicId);
        var to = TopicContext.FilePath(DataRoot, toProjectId, toTopicId);
        try
        {
            if (!File.Exists(from)) return;
            if (File.Exists(to))
            {
                TrashContext(from, $"{fromProjectId}-topic-{fromTopicId}-context.md");
                return;
            }
            Directory.CreateDirectory(TopicContext.ProjectDir(DataRoot, toProjectId));
            File.Move(from, to);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Info($"Couldn't move {from} to {to}: {ex.Message}");
        }
    }

    /// <summary>Moves the listed topics into a category with sort_order 0..n-1 (used by drag and drop).</summary>
    public List<TopicDto> ReorderTopics(long projectId, string category, IReadOnlyList<long> topicIds)
    {
        using var conn = OpenProject(projectId);
        var cat = RequireCategory(conn, category);
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

    /// <summary>
    /// Moves a task to another topic (same task id) at `index` among that topic's tasks (the end when null),
    /// then renumbers both topics' sort orders. Returns the tasks of the target topic.
    /// </summary>
    public List<TaskDto> MoveTask(long projectId, long taskId, long toTopicId, int? index)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, toTopicId);
        var task = GetTask(conn, taskId);
        using (var tx = conn.BeginTransaction())
        {
            var fromTopicId = task.TopicId;
            var ids = ReadTasks(conn, toTopicId).Where(t => t.Id != taskId).Select(t => t.Id).ToList();
            ids.Insert(index is null ? ids.Count : Math.Clamp(index.Value, 0, ids.Count), taskId);
            Exec(conn, "UPDATE tasks SET topic_id = $t WHERE id = $id", ("$t", toTopicId), ("$id", taskId));
            for (int i = 0; i < ids.Count; i++)
                Exec(conn, "UPDATE tasks SET sort_order = $s WHERE id = $id", ("$s", i), ("$id", ids[i]));
            if (fromTopicId != toTopicId)
            {
                var rest = ReadTasks(conn, fromTopicId).Select(t => t.Id).ToList();
                for (int i = 0; i < rest.Count; i++)
                    Exec(conn, "UPDATE tasks SET sort_order = $s WHERE id = $id", ("$s", i), ("$id", rest[i]));
            }
            tx.Commit();
        }
        TouchProject(projectId);
        return ReadTasks(conn, toTopicId);
    }

    public List<TaskDto> ListTasks(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        return ReadTasks(conn, topicId);
    }

    public List<TaskDto> ListPrerequisites(long projectId, long topicId)
    {
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        return ReadTasks(conn, topicId).Where(t => t.Prerequisite).ToList();
    }

    private static TaskDto GetTask(SqliteConnection conn, long taskId)
    {
        using var cmd = Command(conn, "SELECT id, topic_id, title, completed, sort_order, created_at, completed_at, queued, prerequisite, complexity, reply, follow_up, queued_at FROM tasks WHERE id = $id", [("$id", taskId)]);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) throw new NotFoundException($"Task {taskId} not found");
        var title = r.GetString(2);
        var complexity = r.IsDBNull(9) ? ClaudeCli.RateTaskComplexity(title) : Math.Clamp(r.GetInt32(9), 1, 10);
        return new TaskDto(r.GetInt64(0), r.GetInt64(1), title, r.GetInt64(3) != 0,
            r.GetInt64(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6), r.GetInt64(7) != 0, r.GetInt64(8) != 0, complexity, r.IsDBNull(10) ? null : r.GetString(10), r.GetInt64(11) != 0, r.IsDBNull(12) ? null : r.GetString(12));
    }

    public TaskDto AddTask(long projectId, long topicId, string title, bool prerequisite = false, int? complexity = null)
    {
        title = RequireName(title, "Task title");
        var rated = Math.Clamp(complexity ?? ClaudeCli.RateTaskComplexity(title), 1, 10);
        using var conn = OpenProject(projectId);
        GetTopic(conn, topicId);
        var sort = Convert.ToInt64(Scalar(conn,
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE topic_id = $t", ("$t", topicId)));
        var id = Convert.ToInt64(Scalar(conn,
            "INSERT INTO tasks (topic_id, title, sort_order, created_at, prerequisite, complexity) VALUES ($t, $title, $s, $c, $p, $cx) RETURNING id",
            ("$t", topicId), ("$title", title), ("$s", sort), ("$c", Now()), ("$p", prerequisite ? 1 : 0), ("$cx", rated)));
        TouchProject(projectId);
        return GetTask(conn, id);
    }

    public TaskDto GetTask(long projectId, long taskId)
    {
        using var conn = OpenProject(projectId);
        return GetTask(conn, taskId);
    }

    public TaskDto UpdateTask(long projectId, long taskId, string? title, bool? completed, long? sortOrder, bool? queued = null, bool? prerequisite = null, int? complexity = null, bool setReply = false, string? reply = null, bool? followUp = null)
    {
        using var conn = OpenProject(projectId);
        var task = GetTask(conn, taskId);
        if (queued == true && (completed ?? task.Completed))
            throw new ArgumentException("A completed task can't be queued");
        if (complexity is < 1 or > 10)
            throw new ArgumentException("Task complexity must be between 1 and 10");
        if (title is not null)
            Exec(conn, "UPDATE tasks SET title = $t WHERE id = $id", ("$t", RequireName(title, "Task title")), ("$id", taskId));
        if (completed is not null && completed != task.Completed)
            Exec(conn, "UPDATE tasks SET completed = $c, completed_at = $at WHERE id = $id",
                ("$c", completed.Value ? 1 : 0), ("$at", completed.Value ? Now() : null), ("$id", taskId));
        if (sortOrder is not null)
            Exec(conn, "UPDATE tasks SET sort_order = $s WHERE id = $id", ("$s", sortOrder), ("$id", taskId));
        // Finishing a task takes it out of the queue, and reopening it doesn't put it back.
        if (completed == true) queued = false;
        if (queued is not null)
            Exec(conn, "UPDATE tasks SET queued = $q, queued_at = CASE WHEN $q = 0 THEN NULL WHEN queued_at IS NULL OR $was = 0 THEN $now ELSE queued_at END WHERE id = $id",
                ("$q", queued.Value ? 1 : 0), ("$was", task.Queued ? 1 : 0), ("$now", Now()), ("$id", taskId));
        if (prerequisite is not null)
            Exec(conn, "UPDATE tasks SET prerequisite = $p WHERE id = $id", ("$p", prerequisite.Value ? 1 : 0), ("$id", taskId));
        // Only a user task can be a follow-up, so turning it back into an agent task clears the mark.
        if (prerequisite == false)
            followUp = false;
        if (followUp is not null)
        {
            if (followUp == true && !(prerequisite ?? task.Prerequisite))
                throw new ApiProblem(409, "not_user_task", "Only a user task can be a follow-up.");
            Exec(conn, "UPDATE tasks SET follow_up = $f WHERE id = $id", ("$f", followUp.Value ? 1 : 0), ("$id", taskId));
        }
        if (complexity is not null)
            Exec(conn, "UPDATE tasks SET complexity = $cx WHERE id = $id", ("$cx", complexity.Value), ("$id", taskId));
        // A blank reply clears it back to NULL (no reply yet).
        if (setReply)
        {
            if (reply is { Length: > MaxReplyLength })
                throw new ApiProblem(413, "too_large", $"The reply is too long; the limit is {MaxReplyLength} characters");
            Exec(conn, "UPDATE tasks SET reply = $r WHERE id = $id", ("$r", string.IsNullOrWhiteSpace(reply) ? null : reply), ("$id", taskId));
        }
        TouchProject(projectId);
        return GetTask(conn, taskId);
    }

    public const int MaxReplyLength = 20000;

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
    /// <summary>
    /// Queued tasks per project, leaving out projects with none. Archived topics don't count, because their tasks never get a turn.
    /// The UI polls this, so it holds the gate: an open file would stop a deleted project moving to trash.
    /// </summary>
    public List<QueuedCount> QueuedCounts()
    {
        lock (_projectFilesGate)
        {
            List<(long Id, string File)> projects = [];
            using (var index = Open(IndexPath))
            using (var cmd = Command(index, "SELECT id, file_name FROM projects", []))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) projects.Add((r.GetInt64(0), r.GetString(1)));
            }

            var counts = new List<QueuedCount>();
            foreach (var (pid, file) in projects)
            {
                var path = Path.Combine(ProjectsDir, file);
                if (!File.Exists(path)) continue;
                InitProjectDb(path); // projects not opened since an upgrade still need their migrations
                using var conn = Open(path);
                var count = (long)Scalar(conn, "SELECT COUNT(*) FROM tasks k JOIN topics t ON t.id = k.topic_id WHERE k.queued = 1 AND k.completed = 0 AND t.archived_at IS NULL")!;
                if (count > 0) counts.Add(new QueuedCount(pid, count));
            }
            return counts;
        }
    }

    /// <summary>Saved task metrics from every project, newest first. Holds the gate like QueuedCounts.</summary>
    public List<TaskMetric> ListTaskMetrics()
    {
        lock (_projectFilesGate)
        {
            List<(long Id, string Name, string File)> projects = [];
            using (var index = Open(IndexPath))
            using (var cmd = Command(index, "SELECT id, name, file_name FROM projects", []))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) projects.Add((r.GetInt64(0), r.GetString(1), r.GetString(2)));
            }

            var rows = new List<TaskMetric>();
            foreach (var (pid, pname, file) in projects)
            {
                var path = Path.Combine(ProjectsDir, file);
                if (!File.Exists(path)) continue;
                InitProjectDb(path);
                using var conn = Open(path);
                BackfillAntigravityMetrics(conn, pid);
                using var cmd = Command(conn, """
                    SELECT task_id, topic_id, task_title, cli, model, effort, started_at, completed_at, duration_seconds,
                           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, messages
                    FROM task_metrics
                    """, []);
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    rows.Add(new TaskMetric(pid, pname, r.GetInt64(0), NullableLong(r, 1), r.GetString(2), r.GetString(3),
                        r.IsDBNull(4) ? null : r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5),
                        r.IsDBNull(6) ? null : r.GetString(6), r.GetString(7), r.IsDBNull(8) ? null : r.GetDouble(8),
                        NullableLong(r, 9), NullableLong(r, 10), NullableLong(r, 11), NullableLong(r, 12), NullableLong(r, 13)));
                }
            }
            rows.Sort((a, b) => string.CompareOrdinal(b.CompletedAt, a.CompletedAt));
            return rows;
        }
    }

    /// <summary>Fills in token counts for earlier Antigravity task_metrics rows that were saved before token collection existed.</summary>
    private static void BackfillAntigravityMetrics(SqliteConnection conn, long projectId)
    {
        try
        {
            var pending = new List<(long Id, long TaskId, string StartedAt, string CompletedAt)>();
            using (var cmd = Command(conn, """
                SELECT id, task_id, started_at, completed_at
                FROM task_metrics
                WHERE cli = 'antigravity' AND input_tokens IS NULL AND output_tokens IS NULL AND started_at IS NOT NULL
                """, []))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                    pending.Add((r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3)));
            }
            foreach (var (id, taskId, startedAt, completedAt) in pending)
            {
                if (!DateTimeOffset.TryParse(startedAt, out var from) || !DateTimeOffset.TryParse(completedAt, out var to)) continue;
                var tokens = TaskUsage.ReadAntigravity(projectId, taskId, from, to);
                if (tokens is null) continue;
                Exec(conn, """
                    UPDATE task_metrics
                    SET input_tokens = $in, output_tokens = $out, cache_read_tokens = $cr, cache_creation_tokens = $cc, messages = $msgs
                    WHERE id = $id
                    """,
                    ("$in", tokens.Input), ("$out", tokens.Output), ("$cr", tokens.CacheRead),
                    ("$cc", tokens.CacheCreation), ("$msgs", tokens.Messages), ("$id", id));
            }
        }
        catch (Exception ex)
        {
            Log.Info($"Couldn't backfill Antigravity metrics for project {projectId}: {ex.Message}");
        }
    }

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
            InitProjectDb(path); // projects not opened since an upgrade still need their migrations
            using var conn = Open(path);
            const string sql = """
                SELECT t.id, t.title, t.category,
                       CASE WHEN t.title LIKE $q ESCAPE '\' THEN 'title'
                            WHEN t.description LIKE $q ESCAPE '\' THEN 'description'
                            ELSE 'task' END,
                       CASE WHEN t.title LIKE $q ESCAPE '\' THEN t.title
                            WHEN t.description LIKE $q ESCAPE '\' THEN t.description
                            ELSE (SELECT k.title FROM tasks k WHERE k.topic_id = t.id AND k.title LIKE $q ESCAPE '\' ORDER BY k.sort_order LIMIT 1) END,
                       t.archived_at IS NOT NULL,
                       COALESCE((SELECT c.name FROM categories c WHERE c.key = t.category), t.category)
                FROM topics t
                WHERE t.title LIKE $q ESCAPE '\' OR t.description LIKE $q ESCAPE '\'
                   OR EXISTS (SELECT 1 FROM tasks k WHERE k.topic_id = t.id AND k.title LIKE $q ESCAPE '\')
                ORDER BY CASE WHEN t.title LIKE $q ESCAPE '\' THEN 0 ELSE 1 END, t.updated_at DESC
                LIMIT $limit
                """;
            using var cmd = Command(conn, sql, [("$q", pattern), ("$limit", limit - hits.Count)]);
            using var r = cmd.ExecuteReader();
            while (r.Read())
                hits.Add(new SearchHit(pid, pname, r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(6), r.GetString(3), Snippet(r.IsDBNull(4) ? "" : r.GetString(4), query), r.GetInt64(5) != 0));
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

    /// <summary>Consistent copies of every database via VACUUM INTO (safe while in use), plus the topic context files.</summary>
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
        var context = TopicContext.Root(DataRoot);
        if (Directory.Exists(context))
        {
            foreach (var file in Directory.EnumerateFiles(context, "*.md", SearchOption.AllDirectories))
            {
                var target = Path.Combine(folder, "context", Path.GetRelativePath(context, file));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(file, target);
            }
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
