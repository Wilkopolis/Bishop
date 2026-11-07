using System.Text.Json;

namespace Bishop;

/// <summary>
/// The complexity delegation setup: for each agent and intensity (1 to 10), the model and reasoning level.
/// An app setting, not part of any project. Kept in %LOCALAPPDATA%\Bishop\delegation.json, next to settings.json.
/// </summary>
public sealed class DelegationConfig
{
    private static readonly string[] Modes = ["claude", "antigravity"];
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    private readonly string _path = Path.Combine(AppSettings.AppDataDir, "delegation.json");
    private readonly object _gate = new();

    /// <summary>Mode, then intensity as a string, then the choice. Null model or effort: the CLI's own default.</summary>
    public sealed record Config(string Mode, Dictionary<string, Dictionary<string, Choice>> Choices);
    public sealed record Choice(string? Model, string? Effort);

    public Config Load()
    {
        lock (_gate)
        {
            try
            {
                if (File.Exists(_path) && JsonSerializer.Deserialize<Config>(File.ReadAllText(_path), Json) is { } c)
                    return Clean(c);
            }
            catch { }
            return Clean(new Config("claude", []));
        }
    }

    public Config Save(Config config)
    {
        var clean = Clean(config);
        lock (_gate)
        {
            Directory.CreateDirectory(AppSettings.AppDataDir);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(clean, Json));
            File.Move(tmp, _path, overwrite: true);
        }
        return clean;
    }

    /// <summary>Keeps known modes and intensities 1 to 10, trims ids, and turns blanks into null.</summary>
    private static Config Clean(Config c)
    {
        var mode = Modes.Contains(c.Mode) ? c.Mode : "claude";
        var choices = new Dictionary<string, Dictionary<string, Choice>>();
        foreach (var m in Modes)
        {
            var rows = new Dictionary<string, Choice>();
            if (c.Choices is not null && c.Choices.TryGetValue(m, out var src) && src is not null)
                foreach (var (k, v) in src)
                {
                    if (!int.TryParse(k, out var n) || n < 1 || n > 10 || v is null) continue;
                    var model = string.IsNullOrWhiteSpace(v.Model) ? null : v.Model.Trim();
                    var effort = string.IsNullOrWhiteSpace(v.Effort) ? null : v.Effort.Trim();
                    if (model is null && effort is null) continue;
                    rows[n.ToString()] = new Choice(model, effort);
                }
            choices[m] = rows;
        }
        return new Config(mode, choices);
    }
}
