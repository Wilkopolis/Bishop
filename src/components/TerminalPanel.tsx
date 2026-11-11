import { logClient } from '../api/log';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ApiError, api } from '../api/client';
import { aiChoiceFor, aiServiceFor, useBishopStore } from '../store/useBishopStore';
import { AI_SERVICE_LABELS, AI_SERVICES, DEFAULT_EFFORT, DEFAULT_MODEL, effortLabel, levelsOf, type AiService as Backend, type Project, type TerminalInfo, type TerminalKind as Kind } from '../types';
import { ArrowClockwise, CaretDown, Loader2, TerminalWindow, X } from './icons';
import { ContextMenu, type MenuItem } from './ui';

type Session = { id: string; kind: Kind; model: string | null; effort: string | null };

const HEIGHT_KEY = 'bishop_terminal_height';
const MIN_HEIGHT = 120;
const BACKGROUND_CHECK_MS = 3000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const kindLabel = (k: Kind) => (k === 'shell' ? 'PowerShell' : AI_SERVICE_LABELS[k]);
const toSession = (t: TerminalInfo): Session => ({ id: t.id, kind: t.kind, model: t.model, effort: t.effort });

const readHeight = () => {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_HEIGHT ? v : 300;
  } catch {
    return 300;
  }
};

// Warm gray + orange, matching the app.
const theme = {
  background: '#0e0d0c',
  foreground: '#e7e5e4',
  cursor: '#f97316',
  cursorAccent: '#0e0d0c',
  selectionBackground: 'rgba(249, 115, 22, 0.35)',
  black: '#1b1a19',
  red: '#f87171',
  green: '#a3e635',
  yellow: '#fbbf24',
  blue: '#93a4c8',
  magenta: '#e879a6',
  cyan: '#5eead4',
  white: '#d6d3d1',
  brightBlack: '#57524d',
  brightRed: '#fca5a5',
  brightGreen: '#bef264',
  brightYellow: '#fcd34d',
  brightBlue: '#b4c2de',
  brightMagenta: '#f0a3c3',
  brightCyan: '#99f6e4',
  brightWhite: '#fafaf9',
};

const exitNote = (code: number | null | undefined) =>
  `\r\n\x1b[38;2;161;156;151m[process exited${code != null ? ` with code ${code}` : ''}. Use Restart to start again]\x1b[0m\r\n`;

/**
 * One xterm attached to a server-side session over a WebSocket (scrollback is replayed on attach).
 * A view that isn't `visible` stays mounted but hidden, so coming back to its project skips the rebuild and the replay.
 */
function TerminalView({ session, visible }: { session: Session; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const wantsFocus = useBishopStore((s) => s.terminalWantsFocus);
  const clearTerminalFocus = useBishopStore((s) => s.clearTerminalFocus);

  // A button opened the Terminal: focus the shown view once. Nothing else focuses it.
  useEffect(() => {
    if (!visible || !wantsFocus) return;
    const id = requestAnimationFrame(() => {
      host.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
      clearTerminalFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, wantsFocus, clearTerminalFocus]);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));
    term.open(el);
    try {
      fit.fit();
    } catch {}

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal/ws/${session.id}`);
    const send = (payload: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(payload));
    ws.onopen = () => {
      console.log(`[Terminal] WS open for ${session.id}, ${term.cols}x${term.rows}`);
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'replay') {
        term.reset();
        term.write(m.data);
        if (!m.alive) term.write(exitNote(m.exitCode));
      } else if (m.type === 'output') term.write(m.data);
      else if (m.type === 'exit') {
        console.log(`[Terminal] Exit for ${session.id}, code ${m.code}`);
        term.write(exitNote(m.code));
      }
    };
    ws.onclose = () => term.write('');

    term.onData((data) => {
      if (data.length > 1) logClient("info", `[Terminal] input of ${data.length} chars on ${session.id}`);
      send({ type: 'input', data });
    });
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

    const copy = () => {
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text).catch(() => {});
      return !!text;
    };
    const paste = () =>
      navigator.clipboard.readText().then(
        (text) => {
          logClient("info", `[Terminal] paste of ${text.length} chars on ${session.id}`);
          if (text) term.paste(text);
        },
        () => {},
      );

    // Windows Terminal-style keys. Everything else (Ctrl+K, Ctrl+F, …) goes to the program in the terminal.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.code === 'Backquote') return false; // panel toggle, handled by the app
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        copy();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
        paste();
        return false;
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.code === 'KeyC' && term.hasSelection()) {
        copy();
        term.clearSelection();
        return false;
      }
      return true;
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      logClient("info", `[Terminal] contextmenu on ${session.id}, button ${e.button}, t=${Math.round(e.timeStamp)}`);
      // Right-click paste is off for now, to see whether the program in the terminal handles right-click itself.
      if (copy()) term.clearSelection();
    };
    el.addEventListener('contextmenu', onContextMenu);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(el);
    // No term.focus() here: a new session must not take focus from what the user is typing in.

    return () => {
      ro.disconnect();
      el.removeEventListener('contextmenu', onContextMenu);
      ws.close();
      term.dispose();
    };
  }, [session.id]);

  // Hidden has no size, so the resize observer's fit does nothing until the view is shown again.
  return <div ref={host} data-testid={visible ? 'terminal' : undefined} className={visible ? 'absolute inset-0 pl-2 pt-1' : 'hidden'} />;
}

/** Views kept mounted at once. The least recently shown one goes first, and its session keeps running on the host. */
const MAX_MOUNTED_VIEWS = 4;

export function TerminalPanel() {
  // Per-field selectors: the panel re-renders only for what it reads, not on every store update.
  const terminalOpen = useBishopStore((s) => s.terminalOpen);
  const setTerminalOpen = useBishopStore((s) => s.setTerminalOpen);
  const project = useBishopStore((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const workRequest = useBishopStore((s) => s.workRequest);
  const clearWorkRequest = useBishopStore((s) => s.clearWorkRequest);
  const reopenRequest = useBishopStore((s) => s.reopenRequest);
  const clearReopenRequest = useBishopStore((s) => s.clearReopenRequest);
  const pushError = useBishopStore((s) => s.pushError);
  const confirm = useBishopStore((s) => s.confirm);
  const setProjectTerminalChoice = useBishopStore((s) => s.setProjectTerminalChoice);
  const generalBackend = useBishopStore((s) => s.aiService);
  const setBackend = useBishopStore((s) => s.setAiService);
  const models = useBishopStore((s) => s.aiModels);
  const efforts = useBishopStore((s) => s.aiEfforts);
  const setAiChoice = useBishopStore((s) => s.setAiChoice);
  const modelLists = useBishopStore((s) => s.aiModelLists);
  const loadModels = useBishopStore((s) => s.loadAiModels);
  const backend = aiServiceFor(project, generalBackend);
  const [height, setHeight] = useState(readHeight);
  const heightRef = useRef(height);
  heightRef.current = height;
  // Current session per project; sessions keep running on the server while you switch projects.
  // Null: the session moved to the background and the project has no current session.
  const [sessions, setSessions] = useState<Record<number, Session | null>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{ projectId: number; kind: Kind; model: string | null; effort: string | null; text: string; code?: string; taskId?: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const startedFor = useRef(new Set<number>());
  // Session ids with a mounted terminal view, most recently shown first.
  const recentViews = useRef<string[]>([]);
  // A work request is being handled. Until its session exists, a second one (a double click) would start another Claude.
  const handlingWork = useRef(false);
  // For the background check, which outlives renders.
  const sessionsNow = useRef(sessions);
  sessionsNow.current = sessions;
  const startingNow = useRef(false);
  // Reopening moves sessions on the host, so a check that overlaps it has old news. See the background check.
  const handlingReopen = useRef(false);
  const reopens = useRef(0);

  const ready = !!project?.folderPath && !project.folderMissing;
  const session = project ? sessions[project.id] : undefined;
  // A task session can differ from the saved choice. The selectors show what is really running.
  const shownBackend: Backend = session && session.kind !== 'shell' ? session.kind : backend;
  const choiceFor = (b: Backend) => aiChoiceFor(project, b, models, efforts);
  const shownModel = session && session.kind !== 'shell' ? session.model : choiceFor(shownBackend).model;
  const shownEffort = session && session.kind !== 'shell' ? session.effort : choiceFor(shownBackend).effort;
  const modelLabel = (b: Backend, id: string | null) => (id ? (modelLists[b]?.find((m) => m.id === id)?.label ?? id) : DEFAULT_MODEL);

  useEffect(() => {
    if (terminalOpen) loadModels(shownBackend);
  }, [terminalOpen, shownBackend, loadModels]);

  const start = useCallback(
    async (p: Project, kind: Kind, replace?: Session, taskId?: number, model: string | null = null, effort: string | null = null) => {
      startingNow.current = true;
      setStarting(true);
      setError(null);
      try {
        if (replace) await api.closeTerminal(replace.id).catch(() => {});
        const cols = Math.max(40, Math.min(300, Math.floor((window.innerWidth - 32) / 8)));
        const rows = Math.max(10, Math.min(100, Math.floor((heightRef.current - 36) / 17)));
        const info = await api.startTerminal(p.id, kind, cols, rows, taskId, model, effort);
        // A session that continues a topic comes back from the background, so a check under way has old news.
        reopens.current++;
        setSessions((s) => ({ ...s, [p.id]: toSession(info) }));
        // The topic joins Active now, not at the next 3 second refresh.
        if (taskId !== undefined) useBishopStore.getState().markTaskActive(p.id, taskId);
        // The sidebar reads sessions and queue counts, so refresh them now too.
        void useBishopStore.getState().refreshSessions();
      } catch (e) {
        // The old session is gone by now, so forget it. The Try again button keeps the kind, model, level and task it was started for.
        if (replace) {
          startedFor.current.delete(p.id);
          setSessions(({ [p.id]: _closed, ...rest }) => rest);
        }
        setError({ projectId: p.id, kind, model, effort, text: message(e), code: e instanceof ApiError ? e.code : undefined, taskId });
      } finally {
        startingNow.current = false;
        setStarting(false);
      }
    },
    [],
  );

  // The selectors: switch the Terminal to this CLI, model and reasoning level, remember them for new sessions, and save them on the project.
  const pick = async (p: Project, kind: Backend, model: string | null, effort: string | null, current: Session | null | undefined) => {
    const remember = () => {
      setProjectTerminalChoice(p.id, kind, model, effort);
      setBackend(kind);
      setAiChoice(kind, model, effort);
    };
    if (current?.kind === kind && current.model === model && current.effort === effort) return remember();
    let replace = current ?? undefined;
    if (current) {
      // Ask the host: the session may have exited, or moved to the background and must keep running.
      let running = true;
      let inUse = true;
      let task: { title: string | null } | undefined;
      try {
        const found = (await api.listTerminals(p.id)).find((t) => t.id === current.id);
        running = !!found?.alive;
        inUse = !!found?.used;
        if (found?.taskRunning) task = { title: found.taskTitle };
        if (found?.background) {
          replace = undefined;
          running = false;
        }
      } catch {}
      if (running && inUse) {
        const from = kindLabel(current.kind);
        const to = `${kindLabel(kind)}${model ? ` ${modelLabel(kind, model)}` : ''}${effort ? ` (${effortLabel(effort)} reasoning)` : ''}`;
        const ok = await confirm(
          task
            ? {
                title: 'Stop the current task?',
                message: `${from} is still working on ${task.title ? `"${task.title}"` : 'a task'} for ${p.name}. Stop it and start a new ${to} session, or cancel your request.`,
                confirmLabel: 'Stop task',
              }
            : {
                title: `Switch to ${to}?`,
                message: `This ends the current ${from} session for ${p.name} and starts a new ${to} session.`,
                confirmLabel: 'Switch',
              },
        );
        if (!ok) return;
      }
      // While the dialog was open, the session may have moved on or a task may have started. Then the answer is out of date.
      if (sessionsNow.current[p.id]?.id !== current.id || startingNow.current || handlingWork.current) return;
    }
    remember();
    await start(p, kind, replace, undefined, model, effort);
  };

  // Let go of sessions that moved to the background, so Restart and New can't stop them.
  // If the host started the next queued task, its session takes over. Otherwise, if that was the session
  // on screen, close the panel. A session of another project leaves it open.
  useEffect(() => {
    if (!terminalOpen) return;
    let live = true;
    // A session that moved while the panel was hidden must not close it just as the user opens it. See `forget`.
    let justOpened = true;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const reopensBefore = reopens.current;
      api
        .listTerminals()
        .then((all) => {
          if (!live || handlingReopen.current || reopens.current !== reopensBefore) return;
          const moved = new Set(all.filter((t) => t.background).map((t) => t.id));
          const nextTask = (projectId: number) => all.find((t) => t.projectId === projectId && !t.background && t.taskRunning);
          const hasQueued = (projectId: number) => {
            const state = useBishopStore.getState();
            if (state.selectedProjectId === projectId) {
              return state.topics.some((t) => t.tasks.some((k) => k.queued && !k.completed));
            }
            return (state.queuedCounts.find((q) => q.projectId === projectId)?.count ?? 0) > 0;
          };
          const shownProject = useBishopStore.getState().selectedProjectId;
          const shown = shownProject !== null ? sessionsNow.current[shownProject] : null;
          const queuedWaiting = shownProject !== null && hasQueued(shownProject);
          // A session on its way in would open behind a closed panel.
          const shownMoved =
            shownProject !== null && !!shown && moved.has(shown.id) && !nextTask(shownProject) && !queuedWaiting && !handlingWork.current && !startingNow.current;
          // Opening the panel is how the user asks for a session, so the project starts over instead of showing the notice.
          const forget = shownMoved && justOpened ? shownProject : null;
          if (shownMoved && !justOpened) setTerminalOpen(false);
          if (forget !== null) startedFor.current.delete(forget);
          justOpened = false;
          setSessions((s) => {
            const gone = Object.entries(s).filter(([, v]) => v && moved.has(v.id));
            if (!gone.length) return s;
            const replaced = gone.map(([k]) => {
              const pid = Number(k);
              const t = nextTask(pid);
              if (t) return [k, toSession(t)];
              if (hasQueued(pid)) return [k, s[pid]];
              return [k, null];
            });
            const next: typeof s = { ...s, ...Object.fromEntries(replaced) };
            if (forget !== null) delete next[forget];
            return next;
          });
        })
        .catch(() => {}); // background refresh: stay quiet
    };
    check();
    const timer = setInterval(check, BACKGROUND_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [terminalOpen, setTerminalOpen]);

  // The user opened the panel on a project whose session moved to the background: start over, as below.
  // The notice is only for a project the user switches to while the panel is open.
  useEffect(() => {
    if (!terminalOpen || !project || sessions[project.id] !== null || workRequest || reopenRequest) return;
    startedFor.current.delete(project.id);
    setSessions(({ [project.id]: _moved, ...rest }) => rest);
  }, [terminalOpen]);

  // First time the panel shows a project: reuse a running session (e.g. after a reload), else start the selected CLI.
  useEffect(() => {
    if (!terminalOpen || !project || !ready || sessions[project.id] || startedFor.current.has(project.id)) return;
    if (workRequest?.projectId === project.id) return; // the task session below starts instead
    if (reopenRequest?.projectId === project.id) return; // the session below shows instead
    if (starting || error?.projectId === project.id) return; // a start is under way, or the error notice is waiting for the user
    const hasQueued = useBishopStore.getState().topics.some((t) => t.tasks.some((k) => k.queued && !k.completed));
    if (hasQueued) return;
    startedFor.current.add(project.id);
    (async () => {
      try {
        const existing = (await api.listTerminals(project.id)).filter((t) => t.alive && !t.background);
        const latest = existing[existing.length - 1];
        if (latest) {
          setSessions((s) => ({ ...s, [project.id]: toSession(latest) }));
          return;
        }
      } catch {}
      const { model, effort } = choiceFor(backend);
      start(project, backend, undefined, undefined, model, effort);
    })();
  }, [terminalOpen, project?.id, ready, sessions, start, workRequest, reopenRequest, error, starting]);

  // A click in the session feed: show that session again. A live one takes input like any other; an ended one is read-only.
  useEffect(() => {
    if (!terminalOpen || !reopenRequest || !project || project.id !== reopenRequest.projectId || starting) return;
    const { sessionId } = reopenRequest;
    clearReopenRequest();
    if (handlingReopen.current) return;
    handlingReopen.current = true;
    startedFor.current.add(project.id);
    api
      .reopenTerminal(sessionId)
      .then((info) => {
        setError(null);
        setSessions((s) => ({ ...s, [project.id]: toSession(info) }));
      })
      .catch((e) => {
        pushError(e);
        // Whatever the panel showed stays. With nothing to show, the panel closes again.
        if (sessionsNow.current[project.id]) return;
        setTerminalOpen(false);
        startedFor.current.delete(project.id);
      })
      .finally(() => {
        handlingReopen.current = false;
        reopens.current++;
      });
  }, [terminalOpen, reopenRequest, project?.id, starting]);

  // "Work on this task": a session of the selected CLI reads the task's brief. That's a fresh session, unless it's Claude and
  // the topic is in same session mode: then the host continues the topic's previous session.
  useEffect(() => {
    if (!terminalOpen || !workRequest || !project || project.id !== workRequest.projectId || !ready) return;
    const { taskId } = workRequest;
    const kind = backend;
    // No model or level here: the host picks them from the complexity breakdown. The project's choice is for blank Terminals.
    const topic = useBishopStore.getState().topics.find((t) => t.tasks.some((k) => k.id === taskId));
    // Bishop only keeps Claude conversations, so Antigravity always starts a new session.
    const sameSession = kind === 'claude' && !!topic?.sameSession;
    clearWorkRequest();
    if (handlingWork.current) return;
    handlingWork.current = true;
    startedFor.current.add(project.id);
    (async () => {
      // Answered here, before anything stops or starts: agy would run the task behind its own trust dialog.
      if (kind === 'antigravity') {
        try {
          if (!(await api.antigravityTrust(project.id)).trusted) {
            const ok = await confirm({
              title: 'Trust this folder in Antigravity?',
              message: `Antigravity can read, edit and run files in ${project.folderPath} without asking first. It remembers this for the folder. Only trust folders whose contents you trust.`,
              confirmLabel: 'Trust folder',
            });
            if (!ok) return;
            await api.trustAntigravityFolder(project.id);
          }
        } catch (e) {
          pushError(e);
          return;
        }
      }
      let current = sessions[project.id] ?? undefined;
      // Ask the host: `current` may have exited, and after a reload a running session isn't in it yet.
      let running: Session | undefined;
      // The session the panel starts by itself counts as running, but nobody has used it: nothing to lose.
      let inUse = false;
      // What the CLI is still working on, if anything: a new task would stop it.
      let runningTask: { id: number | null; title: string | null } | undefined;
      // Same session mode, and the topic's previous session is alive and free: the host hands it the task.
      let continuing = false;
      try {
        const all = await api.listTerminals(project.id);
        // The check above may not have seen this yet. A background session stays running.
        if (all.some((t) => t.id === current?.id && t.background)) current = undefined;
        const agents = all.filter((t) => t.alive && t.kind !== 'shell' && !t.background);
        // A session still on a task comes first: that's the one a new task would interrupt.
        const found = agents.find((t) => t.taskRunning) ?? agents.find((t) => t.id === current?.id) ?? agents[agents.length - 1];
        running = found && toSession(found);
        inUse = !!found?.used;
        if (found?.taskRunning) runningTask = { id: found.taskId, title: found.taskTitle };
        continuing = sameSession && all.some((t) => t.alive && t.kind === 'claude' && t.topicId === topic?.id && !t.taskRunning);
      } catch {
        running = current && current.kind !== 'shell' ? current : undefined;
        inUse = !!running;
      }
      // Show it now, so saying no leaves the panel on the running session.
      if (running && !current) setSessions((s) => ({ ...s, [project.id]: running }));
      const runningLabel = kindLabel(running?.kind ?? kind);
      if (runningTask) {
        const name = runningTask.title ? `"${runningTask.title}"` : 'a task';
        const ok = await confirm({
          title: 'Stop the current task?',
          message:
            runningTask.id === taskId
              ? `${runningLabel} is already working on ${name} for ${project.name}. Stop it and start this task again, or cancel your request.`
              : `${runningLabel} is still working on ${name} for ${project.name}. Stop it and start the new task, or cancel your request.`,
          confirmLabel: 'Stop task',
        });
        if (!ok) return;
      } else if (
        !continuing &&
        inUse &&
        !(await confirm({
          title: `Start ${kindLabel(kind)} on this task?`,
          message: sameSession
            ? `This ends the current ${runningLabel} session for ${project.name} and starts the task in this topic's previous session, if it has one.`
            : `This ends the current ${runningLabel} session for ${project.name} and starts a new ${kindLabel(kind)} session for the task.`,
          confirmLabel: 'Start',
        }))
      )
        return;
      // Stops the old session first, so two sessions don't work in the folder at once. A background session stays: it has
      // finished its task, unless the user reopened another session while it was working. A session that continues needs
      // nothing stopped: the host moves whatever the Terminal shows to the background, the way reopening a session does.
      await start(project, kind, continuing && !runningTask ? undefined : (running ?? current), taskId);
    })().finally(() => {
      handlingWork.current = false;
    });
  }, [terminalOpen, workRequest, project?.id, ready]);

  // Drag the top edge to resize; remembered.
  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      const max = window.innerHeight - 160;
      setHeight(Math.max(MIN_HEIGHT, Math.min(max, startH + (startY - ev.clientY))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setHeight((h) => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
        } catch {}
        return h;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Keep a view per recent session mounted, and show the one for this project. Order by id so views never move in the DOM.
  const showingView = !!project && ready && !(error && error.projectId === project.id) && !!session;
  if (showingView && session) {
    recentViews.current = [session.id, ...recentViews.current.filter((id) => id !== session.id)];
  }
  const live = new Map<string, Session>();
  for (const v of Object.values(sessions)) if (v) live.set(v.id, v);
  recentViews.current = recentViews.current.filter((id) => live.has(id)).slice(0, MAX_MOUNTED_VIEWS);
  const mountedSessions = recentViews.current
    .map((id) => live.get(id)!)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (!terminalOpen) {
    recentViews.current = []; // closing the panel unmounts every view
    return null;
  }

  const headerBtn = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-[var(--card)] disabled:opacity-40';
  const openMenu = (el: HTMLElement, items: MenuItem[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };
  const openModelMenu = async (el: HTMLElement, p: Project) => {
    const known = modelLists[shownBackend];
    // An empty list means the CLI couldn't answer, so ask again.
    const list = known?.length ? known : await loadModels(shownBackend);
    const choice = (id: string | null, label: string): MenuItem => ({
      label,
      checked: id === shownModel,
      // A level the new model doesn't take would stop the CLI from starting.
      onSelect: () => pick(p, shownBackend, id, shownEffort && levelsOf(list, id).includes(shownEffort) ? shownEffort : null, session),
    });
    openMenu(el, [
      choice(null, DEFAULT_MODEL),
      ...list.map((m) => choice(m.id, m.label)),
      ...(list.length ? [] : [{ label: "Couldn't list the models", disabled: true }]),
    ]);
  };
  const openEffortMenu = async (el: HTMLElement, p: Project) => {
    const known = modelLists[shownBackend];
    const list = known?.length ? known : await loadModels(shownBackend);
    const levels = levelsOf(list, shownModel);
    const choice = (effort: string | null, label: string): MenuItem => ({
      label,
      checked: effort === shownEffort,
      onSelect: () => pick(p, shownBackend, shownModel, effort, session),
    });
    openMenu(el, [
      choice(null, DEFAULT_EFFORT),
      ...levels.map((e) => choice(e, effortLabel(e))),
      ...(levels.length ? [] : [{ label: list.length ? 'This model has no levels' : "Couldn't list the levels", disabled: true }]),
    ]);
  };

  return (
    <section
      data-testid="terminal-panel"
      aria-label="Terminal"
      className="relative shrink-0 flex flex-col border-t border-[var(--border)] bg-[#0e0d0c]"
      style={{ height }}
    >
      <div
        className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-10 hover:bg-[var(--primary-subtle)]"
        title="Drag to resize"
        onPointerDown={onDragStart}
      />
      <header className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-[var(--border)] bg-[var(--sidebar)] text-xs">
        <TerminalWindow size={14} className="text-[var(--primary-text)] shrink-0" />
        {project?.displayType !== 'personal' && <button
          data-testid="terminal-backend"
          className={`${headerBtn} shrink-0 font-semibold`}
          disabled={!project || !ready || starting}
          title="Choose the CLI to run in this terminal"
          onClick={(e) =>
            project &&
            openMenu(
              e.currentTarget,
              AI_SERVICES.map((b) => ({
                label: kindLabel(b),
                checked: b === shownBackend,
                // Picking the CLI that is running keeps its model and level.
                onSelect: () =>
                  b === session?.kind ? pick(project, b, session.model, session.effort, session) : pick(project, b, choiceFor(b).model, choiceFor(b).effort, session),
              })),
            )
          }
        >
          {kindLabel(session?.kind ?? backend)} <CaretDown size={11} />
        </button>}
        {session?.kind !== 'shell' && project?.displayType !== 'personal' && (
          <>
            <button
              data-testid="terminal-model"
              className={`${headerBtn} shrink-0`}
              disabled={!project || !ready || starting}
              title="Choose the model for this terminal"
              onClick={(e) => project && openModelMenu(e.currentTarget, project)}
            >
              {modelLabel(shownBackend, shownModel)} <CaretDown size={11} />
            </button>
            <button
              data-testid="terminal-effort"
              className={`${headerBtn} shrink-0`}
              disabled={!project || !ready || starting}
              title="Choose the reasoning level for this terminal"
              onClick={(e) => project && openEffortMenu(e.currentTarget, project)}
            >
              {shownEffort ? effortLabel(shownEffort) : DEFAULT_EFFORT} <CaretDown size={11} />
            </button>
          </>
        )}
        {project && <span className="shrink-0 text-[var(--muted-foreground)]">· {project.name}</span>}
        {project?.folderPath && (
          <span className="truncate font-mono text-[var(--muted-foreground)]" title={project.folderPath}>
            {project.folderPath}
          </span>
        )}
        <div className="flex-1" />
        {starting && <Loader2 size={13} className="animate-spin text-[var(--muted-foreground)]" />}
        <button
          className={headerBtn}
          disabled={!project || !ready || !session || starting}
          title="Restart this session"
          onClick={() => project && session && start(project, session.kind, session, undefined, session.model, session.effort)}
        >
          <ArrowClockwise size={13} /> Restart
        </button>
        <button
          className={headerBtn}
          disabled={!project || !ready || starting}
          title="Start a new session"
          onClick={(e) =>
            project &&
            openMenu(e.currentTarget, [
              { label: `New ${kindLabel(shownBackend)} session`, onSelect: () => start(project, shownBackend, session ?? undefined, undefined, shownModel, shownEffort) },
              { label: 'New PowerShell session', onSelect: () => start(project, 'shell', session ?? undefined) },
            ])
          }
        >
          New <CaretDown size={11} />
        </button>
        <button className={headerBtn} title="Hide terminal (Ctrl+`)" onClick={() => setTerminalOpen(false)}>
          <X size={13} />
        </button>
      </header>
      <div className="relative flex-1 min-h-0">
        {!project ? (
          <Notice text="Select a project to open a terminal in its folder." />
        ) : !ready ? (
          <Notice text="This project needs a folder before a terminal can start. Choose one in the banner above." />
        ) : error && error.projectId === project.id ? (
          <div className="p-4 flex flex-col gap-2 text-sm">
            <span className="text-red-300">{error.text}</span>
            <div className="flex gap-2">
              <button className="px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--card)]" onClick={() => start(project, error.kind, undefined, error.taskId, error.model, error.effort)}>
                Try {kindLabel(error.kind)} again
              </button>
              <button className="px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--card)]" onClick={() => start(project, 'shell')}>
                Open PowerShell instead
              </button>
            </div>
          </div>
        ) : session ? null : session === null ? (
          <Notice text="This session moved to the background. Find it under Sessions in the sidebar, or use New to start another." />
        ) : (
          <Notice text="Starting…" />
        )}
        {mountedSessions.map((m) => (
          <TerminalView key={m.id} session={m} visible={showingView && m.id === session?.id} />
        ))}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function Notice({ text }: { text: string }) {
  return <div className="h-full grid place-items-center text-sm text-[var(--muted-foreground)] px-6 text-center">{text}</div>;
}
