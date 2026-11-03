using System.Diagnostics;
using System.Globalization;

namespace Bishop;

public record BackupInfo(string Name, string Path, string CreatedAt, long SizeBytes);

/// <summary>
/// Timestamped backups under &lt;data root&gt;\backups\yyyyMMdd-HHmmss\. One automatic
/// backup per day on startup; only the newest <see cref="Keep"/> are kept.
/// </summary>
public sealed class Backups(Storage storage)
{
    public const int Keep = 14;
    private const string Format = "yyyyMMdd-HHmmss";
    private readonly object _gate = new();

    public string Root => Path.Combine(storage.DataRoot, "backups");

    public List<BackupInfo> List()
    {
        if (!Directory.Exists(Root)) return [];
        return Directory.EnumerateDirectories(Root)
            .Select(d => (Dir: d, Ok: DateTime.TryParseExact(Path.GetFileName(d), Format, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var t), Time: t))
            .Where(x => x.Ok)
            .OrderByDescending(x => x.Time)
            .Select(x => new BackupInfo(
                Path.GetFileName(x.Dir),
                x.Dir,
                x.Time.ToUniversalTime().ToString("o"),
                Directory.EnumerateFiles(x.Dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length)))
            .ToList();
    }

    public BackupInfo BackupNow()
    {
        lock (_gate)
        {
            var name = DateTime.Now.ToString(Format, CultureInfo.InvariantCulture);
            var dir = Path.Combine(Root, name);
            if (Directory.Exists(dir))
            {
                // Names have one-second resolution; wait for the next one.
                Thread.Sleep(1000);
                name = DateTime.Now.ToString(Format, CultureInfo.InvariantCulture);
                dir = Path.Combine(Root, name);
            }
            var tmp = dir + ".partial";
            var sw = Stopwatch.StartNew();
            try
            {
                if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
                storage.BackupTo(tmp);
                Directory.Move(tmp, dir);
            }
            catch
            {
                try { Directory.Delete(tmp, true); } catch { }
                throw;
            }
            Prune();
            var info = List().First(b => b.Name == name);
            Log.Info($"Backup written to {dir} in {sw.ElapsedMilliseconds}ms ({info.SizeBytes / 1024} KB)");
            return info;
        }
    }

    /// <summary>Back up if there's no backup from today yet.</summary>
    public void RunDailyIfDue()
    {
        try
        {
            var today = DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            if (List().Any(b => b.Name.StartsWith(today, StringComparison.Ordinal))) return;
            BackupNow();
        }
        catch (Exception ex)
        {
            Log.Info($"Daily backup failed: {ex.Message}");
        }
    }

    private void Prune()
    {
        foreach (var old in List().Skip(Keep))
        {
            try { Directory.Delete(old.Path, true); } catch { }
        }
    }
}
