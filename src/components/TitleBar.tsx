import { useEffect, useState } from 'react';
import { Copy, Minus, Square, TerminalWindow, X } from './icons';
import { windowApi } from '../api/client';
import { BishopLogo } from './BishopLogo';
import { useBishopStore } from '../store/useBishopStore';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const onWinState = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.isMaximized === 'boolean') setIsMaximized(detail.isMaximized);
    };
    window.addEventListener('bishop-window-state', onWinState);
    return () => window.removeEventListener('bishop-window-state', onWinState);
  }, []);

  const toggleMaximize = async () => {
    const r = await windowApi.maximize();
    if (typeof r.isMaximized === 'boolean') setIsMaximized(r.isMaximized);
  };

  return (
    <div
      className="h-9 shrink-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--sidebar)]"
      onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest('button')) windowApi.drag();
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) toggleMaximize();
      }}
    >
      <div className="flex items-center gap-2 px-3">
        <BishopLogo size={16} className="text-[var(--primary-hover)]" />
        <span className="font-semibold tracking-tight text-[13px] leading-none text-[var(--foreground)]">Bishop</span>
      </div>
      <div className="flex h-full">
        <TerminalToggle />
        <button className="w-11 h-full grid place-items-center hover:bg-[var(--card)]" onClick={() => windowApi.minimize()} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="w-11 h-full grid place-items-center hover:bg-[var(--card)]" onClick={toggleMaximize} title="Maximize">
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className="w-11 h-full grid place-items-center hover:bg-red-600 hover:text-white" onClick={() => windowApi.close()} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function TerminalToggle() {
  const { terminalOpen, setTerminalOpen } = useBishopStore();
  return (
    <button
      className={`h-full px-3 flex items-center gap-1.5 text-xs hover:bg-[var(--card)] ${terminalOpen ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
      title="Terminal (Ctrl+`)"
      aria-pressed={terminalOpen}
      onClick={() => setTerminalOpen(!terminalOpen)}
    >
      <TerminalWindow size={15} /> Terminal
    </button>
  );
}

const HANDLES: { dir: string; className: string }[] = [
  { dir: 'top', className: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { dir: 'bottom', className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { dir: 'left', className: 'top-3 bottom-3 left-0 w-1.5 cursor-ew-resize' },
  { dir: 'right', className: 'top-3 bottom-3 right-0 w-1.5 cursor-ew-resize' },
  { dir: 'topLeft', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { dir: 'topRight', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { dir: 'bottomLeft', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { dir: 'bottomRight', className: 'bottom-0 right-0 w-4 h-4 cursor-nwse-resize' },
];

/** 8-way resize handles for the frameless native window. */
export function ResizeHandles() {
  return (
    <>
      {HANDLES.map((h) => (
        <div key={h.dir} onMouseDown={() => windowApi.resize(h.dir)} className={`fixed z-50 ${h.className}`} />
      ))}
    </>
  );
}
