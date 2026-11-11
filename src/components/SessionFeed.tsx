import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useBishopStore } from '../store/useBishopStore';
import type { SessionRecord, TerminalInfo } from '../types';
import { ProjectIcon } from './ProjectIcon';

const REFRESH_MS = 3000;
const HISTORY_MS = 30000;
const HISTORY_DAYS = 7;

/** A saved session from the past week, with its project. */
type PastSession = SessionRecord & { projectId: number };

// Sessions with no end or finish time go first: they may still be working.
const sortKey = (t: TerminalInfo) => {
  const time = t.endedAt ?? t.taskFinishedAt;
  return time === null ? Infinity : Date.parse(time);
};
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The text at the end of a session entry: when the session last had activity. Within the last 24 hours that is just
 * the time, e.g. "4:12 PM"; older sessions show the month and day, e.g. "Nov 7". No status words.
 */
const timeText = (lastActivityAt: string) => {
  const at = new Date(lastActivityAt);
  const recent = Date.now() - at.getTime() < DAY_MS;
  return recent
    ? at.toLocaleString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString([], { month: 'short', day: 'numeric' });
};

/**
 * Used sessions that aren't on screen, newest first: hiding the Terminal puts its session here, and sessions that ended
 * stay and stack up until the app closes. Clicking one reopens it in the Terminal; an ended one shows its scrollback.
 * Past sessions from this run that the host no longer holds (saved in each project) are listed after them, not clickable.
 * Sessions from earlier runs of Bishop are not listed: their Terminals can't be reached.
 * One line each: the project shows as its icon, and its name is in the tooltip. Under the projects list; always shown, with a note when there are none.
 */
export function SessionFeed({ maxHeight }: { maxHeight?: number } = {}) {
  const projects = useBishopStore((s) => s.projects);
  const reopenSession = useBishopStore((s) => s.reopenSession);
  const terminalOpen = useBishopStore((s) => s.terminalOpen);
  const selectedProjectId = useBishopStore((s) => s.selectedProjectId);
  const sessions = useBishopStore((s) => s.sessions);
  const refreshSessions = useBishopStore((s) => s.refreshSessions);

  // The projects list reads these sessions too, so this one refresh serves both.
  useEffect(() => {
    const load = () => {
      if (document.visibilityState === 'visible') refreshSessions();
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [refreshSessions]);

  // Saved sessions from this run, for every project. Live sessions win by id, so only ones the host no longer holds show here.
  const projectIds = projects.map((p) => p.id).join(',');
  const [history, setHistory] = useState<PastSession[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ids = projectIds === '' ? [] : projectIds.split(',').map(Number);
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      const lists = await Promise.all(
        ids.map((projectId) =>
          api.listRecentSessions(projectId, HISTORY_DAYS).then(
            (rows) => rows.map((r): PastSession => ({ ...r, projectId })),
            () => [] as PastSession[],
          ),
        ),
      );
      // Same rows as last time: keep the old array, so the feed doesn't re-render on every poll.
      if (!cancelled) {
        const next = lists.flat();
        setHistory((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }
    };
    void load();
    const timer = setInterval(load, HISTORY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectIds]);

  // Decided here, not on load, so a session shows up the moment the Terminal closes.
  const onScreen = (t: TerminalInfo) => !t.background && terminalOpen && t.projectId === selectedProjectId;
  // Background sessions always count as used. A session nobody has touched has nothing to come back to.
  // Two sessions with no finish time keep the host's order.
  const shown = (sessions ?? [])
    .filter((t) => t.used && !onScreen(t))
    .sort((a, b) => (sortKey(a) === sortKey(b) ? 0 : sortKey(b) - sortKey(a)));
  const liveIds = new Set((sessions ?? []).map((t) => t.id));
  const past = history.filter((r) => !liveIds.has(r.id)).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  if (maxHeight !== undefined && maxHeight <= 0) return null;

  return (
    <section
      data-testid="session-feed"
      aria-label="Sessions"
      className="shrink-0 flex flex-col border-t border-[var(--border)] overflow-hidden"
      style={maxHeight !== undefined ? { maxHeight: `${maxHeight}px` } : undefined}
    >
      <span className="shrink-0 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Sessions</span>
      <ul className="min-h-0 overflow-y-auto px-1 pb-2">
        {shown.length === 0 && past.length === 0 && <li className="px-2 py-0.5 text-sm text-[var(--muted-foreground)]">No sessions yet</li>}
        {shown.map((s) => {
          const project = projects.find((p) => p.id === s.projectId);
          return (
            <li key={s.id}>
              <button
                className="w-full flex items-center gap-2 px-2 py-0.5 rounded text-sm text-left hover:bg-[var(--card)]"
                title={[project?.name, s.taskTitle ?? s.title].filter(Boolean).join(': ')}
                onClick={() => reopenSession(s.projectId, s.id)}
              >
                {project && <ProjectIcon project={project} />}
                <span className="min-w-0 flex-1 truncate">{s.taskTitle ?? s.title}</span>
                <span className="shrink-0 whitespace-nowrap text-xs text-[var(--muted-foreground)]">
                  {timeText(s.lastActivityAt)}
                </span>
              </button>
            </li>
          );
        })}
        {past.map((r) => {
          const project = projects.find((p) => p.id === r.projectId);
          const name = r.taskTitle ?? r.title;
          return (
            <li key={`past-${r.id}`}>
              <div
                className="w-full flex items-center gap-2 px-2 py-0.5 rounded text-sm text-[var(--muted-foreground)]"
                title={[project?.name, name].filter(Boolean).join(': ')}
              >
                {project && <ProjectIcon project={project} />}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 whitespace-nowrap text-xs">{timeText(r.lastActivityAt)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
