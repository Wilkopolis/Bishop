import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ApiError, api } from '../api/client';
import { useBishopStore } from '../store/useBishopStore';
import type { Project } from '../types';
import { ArrowClockwise, CaretDown, Loader2, TerminalWindow, X } from './icons';
import { ContextMenu, type MenuItem } from './ui';

type Kind = 'claude' | 'shell';
type Session = { id: string; kind: Kind };

const HEIGHT_KEY = 'bishop_terminal_height';
const MIN_HEIGHT = 120;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/** One xterm attached to a server-side session over a WebSocket (scrollback is replayed on attach). */
function TerminalView({ session }: { session: Session }) {
  const host = useRef<HTMLDivElement>(null);

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
    ws.onopen = () => send({ type: 'resize', cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'replay') {
        term.reset();
        term.write(m.data);
        if (!m.alive) term.write(exitNote(m.exitCode));
      } else if (m.type === 'output') term.write(m.data);
      else if (m.type === 'exit') term.write(exitNote(m.code));
    };
    ws.onclose = () => term.write('');

    term.onData((data) => send({ type: 'input', data }));
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

    const copy = () => {
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text).catch(() => {});
      return !!text;
    };
    const paste = () =>
      navigator.clipboard.readText().then(
        (text) => text && term.paste(text),
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
      if (!copy()) paste();
      else term.clearSelection();
    };
    el.addEventListener('contextmenu', onContextMenu);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(el);
    term.focus();

    return () => {
      ro.disconnect();
      el.removeEventListener('contextmenu', onContextMenu);
      ws.close();
      term.dispose();
    };
  }, [session.id]);

  return <div ref={host} data-testid="terminal" className="absolute inset-0 pl-2 pt-1" />;
}

export function TerminalPanel() {
  const { terminalOpen, setTerminalOpen, projects, selectedProjectId } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);
  const [height, setHeight] = useState(readHeight);
  // Current session per project; sessions keep running on the server while you switch projects.
  const [sessions, setSessions] = useState<Record<number, Session>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{ projectId: number; text: string; code?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const startedFor = useRef(new Set<number>());

  const ready = !!project?.folderPath && !project.folderMissing;
  const session = project ? sessions[project.id] : undefined;

  const start = useCallback(
    async (p: Project, kind: Kind, replace?: Session) => {
      setStarting(true);
      setError(null);
      try {
        if (replace) await api.closeTerminal(replace.id).catch(() => {});
        const info = await api.startTerminal(p.id, kind, 120, 30);
        setSessions((s) => ({ ...s, [p.id]: { id: info.id, kind: info.kind } }));
      } catch (e) {
        setError({ projectId: p.id, text: message(e), code: e instanceof ApiError ? e.code : undefined });
      } finally {
        setStarting(false);
      }
    },
    [],
  );

  // First time the panel shows a project: reuse a running session (e.g. after a reload), else start claude.
  useEffect(() => {
    if (!terminalOpen || !project || !ready || sessions[project.id] || startedFor.current.has(project.id)) return;
    startedFor.current.add(project.id);
    (async () => {
      try {
        const existing = (await api.listTerminals(project.id)).filter((t) => t.alive);
        const latest = existing[existing.length - 1];
        if (latest) {
          setSessions((s) => ({ ...s, [project.id]: { id: latest.id, kind: latest.kind } }));
          return;
        }
      } catch {}
      start(project, 'claude');
    })();
  }, [terminalOpen, project?.id, ready, sessions, start]);

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

  if (!terminalOpen) return null;

  const kindLabel = (k: Kind) => (k === 'claude' ? 'Claude' : 'PowerShell');
  const headerBtn = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-[var(--card)] disabled:opacity-40';

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
        <span className="font-semibold shrink-0">{session ? kindLabel(session.kind) : 'Terminal'}</span>
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
          onClick={() => project && session && start(project, session.kind, session)}
        >
          <ArrowClockwise size={13} /> Restart
        </button>
        <button
          className={headerBtn}
          disabled={!project || !ready || starting}
          title="Start a new session"
          onClick={(e) => {
            if (!project) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 2,
              items: [
                { label: 'New Claude session', onSelect: () => start(project, 'claude', session) },
                { label: 'New PowerShell session', onSelect: () => start(project, 'shell', session) },
              ],
            });
          }}
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
              <button className="px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--card)]" onClick={() => start(project, 'claude')}>
                Try Claude again
              </button>
              <button className="px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--card)]" onClick={() => start(project, 'shell')}>
                Open PowerShell instead
              </button>
            </div>
          </div>
        ) : session ? (
          <TerminalView key={session.id} session={session} />
        ) : (
          <Notice text="Starting…" />
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function Notice({ text }: { text: string }) {
  return <div className="h-full grid place-items-center text-sm text-[var(--muted-foreground)] px-6 text-center">{text}</div>;
}
