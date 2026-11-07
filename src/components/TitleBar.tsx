import { useEffect, useRef, useState } from 'react';
import { Bell, BellSlash, Check, CaretDown, ChartBar, Copy, Minus, Sparkles, Square, TerminalWindow, X } from './icons';
import { api, windowApi } from '../api/client';
import { BishopLogo } from './BishopLogo';
import { useBishopStore } from '../store/useBishopStore';
import type { AiService } from '../types';

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
        if (e.button === 0 && !(e.target as HTMLElement).closest('button, select')) windowApi.drag();
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, select')) toggleMaximize();
      }}
    >
      {/* The logo has about 3px of empty space on each side at this size. The smaller left padding and gap
          make up for it, so the visible icon lines up with the sidebar header and sits 8px from the name.
          The logo box fills the bar's 35px content area: a 16px box would land on a half pixel and snap low.
          The name's box is trimmed to its capital letters, so the bar centers the letters and not the font's line box. */}
      <div className="flex h-full items-center gap-1 pl-[9px] pr-3">
        <BishopLogo size={16} boxHeight={35} className="text-[var(--primary-hover)]" />
        <span className="font-semibold tracking-tight text-[13px] leading-none [text-box:trim-both_cap_alphabetic] text-[var(--foreground)]">Bishop</span>
      </div>
      <div className="flex h-full">
        <div className="flex h-full border-x border-[var(--border)]" role="toolbar" aria-label="Tools">
          <TerminalToggle />
          <ChartsButton />
          <DelegationButton />
        </div>
        <ModelPicker />
        <SilentToggle />
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

function SilentToggle() {
  const { silentMode, setSilentMode } = useBishopStore();
  // The host does the flashing, so it needs the value on load and on every change.
  useEffect(() => {
    api.setSilentMode(silentMode).catch(() => {});
  }, [silentMode]);
  return (
    <button
      className={`w-11 h-full grid place-items-center hover:bg-[var(--card)] ${silentMode ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
      title={silentMode ? 'Silent mode is on: Bishop does not flash in the taskbar' : 'Silent mode is off'}
      aria-pressed={silentMode}
      onClick={() => setSilentMode(!silentMode)}
    >
      {silentMode ? <BellSlash size={15} /> : <Bell size={15} />}
    </button>
  );
}

function TerminalToggle() {
  const { terminalOpen, setTerminalOpen } = useBishopStore();
  return (
    <button
      className={`w-11 h-full grid place-items-center hover:bg-[var(--card)] ${terminalOpen ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
      title="Terminal (Ctrl+`)"
      aria-label="Terminal (Ctrl+`)"
      aria-pressed={terminalOpen}
      onClick={() => setTerminalOpen(!terminalOpen)}
    >
      <TerminalWindow size={15} />
    </button>
  );
}

function ChartsButton() {
  const { chartsOpen, setChartsOpen } = useBishopStore();
  return (
    <button
      className={`w-11 h-full grid place-items-center hover:bg-[var(--card)] ${chartsOpen ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
      title="Performance charts"
      aria-label="Performance charts"
      aria-pressed={chartsOpen}
      onClick={() => setChartsOpen(!chartsOpen)}
    >
      <ChartBar size={15} />
    </button>
  );
}

function DelegationButton() {
  const { delegationOpen, setDelegationOpen } = useBishopStore();
  return (
    <button
      className={`w-11 h-full grid place-items-center hover:bg-[var(--card)] ${delegationOpen ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
      title="Complexity delegation"
      aria-label="Complexity delegation"
      aria-pressed={delegationOpen}
      onClick={() => setDelegationOpen(!delegationOpen)}
    >
      <Sparkles size={15} />
    </button>
  );
}

const MODEL_KEY = 'bishop.backgroundModel';
const EFFORT_KEY = 'bishop.backgroundEffort';
const SERVICE_KEY = 'bishop.backgroundService';

/** Premium model and reasoning level the dropdown leaves out. A saved choice of either reads as no choice. */
const HIDDEN_MODELS = ['fable'];
const HIDDEN_EFFORTS = ['max'];
/** The Antigravity models the dropdown offers: Gemini Flash and Argon, each at low, medium and high. agy also lists Claude and GPT. */
const ANTIGRAVITY_MODELS = ['flash', 'argon'];
const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'];

const readSaved = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Model and reasoning level for background work such as importing and refining tasks. */
function ModelPicker() {
  const { aiModelLists, loadAiModels } = useBishopStore();
  const [open, setOpen] = useState(false);
  const [service, setService] = useState<AiService>(() => (readSaved(SERVICE_KEY) === 'antigravity' ? 'antigravity' : 'claude'));
  const [model, setModel] = useState<string | null>(() => {
    const saved = readSaved(MODEL_KEY);
    return saved && !(readSaved(SERVICE_KEY) !== 'antigravity' && HIDDEN_MODELS.includes(saved)) ? saved : null;
  });
  const [effort, setEffort] = useState<string | null>(() => {
    const saved = readSaved(EFFORT_KEY);
    return saved && !HIDDEN_EFFORTS.includes(saved) ? saved : null;
  });
  const ref = useRef<HTMLDivElement>(null);
  const claudeModels = aiModelLists.claude
    ?.filter((m) => !HIDDEN_MODELS.includes(m.id))
    .map((m) => ({ ...m, service: 'claude' as AiService, efforts: m.efforts.filter((lvl) => !HIDDEN_EFFORTS.includes(lvl)) }));
  const antigravityModels = aiModelLists.antigravity
    ?.filter((m) => ANTIGRAVITY_MODELS.some((name) => m.id.toLowerCase().includes(name)))
    .map((m) => ({ ...m, service: 'antigravity' as AiService, efforts: m.efforts.filter((lvl) => ANTIGRAVITY_EFFORTS.includes(lvl)) }));
  // Unknown (undefined) until one service has answered. The other's models join when it does.
  const models = claudeModels || antigravityModels ? [...(claudeModels ?? []), ...(antigravityModels ?? [])] : undefined;
  const modelLabel = model ? (models?.find((m) => m.id === model && m.service === service)?.label ?? model) : 'Background model';
  const shown = model && effort ? `${modelLabel} · ${effort}` : modelLabel;

  const loadLists = () => {
    if (!claudeModels?.length) loadAiModels('claude');
    if (!antigravityModels?.length) loadAiModels('antigravity');
  };

  useEffect(() => {
    if (model) loadLists();
  }, []);

  // Tell the host which model to use for background work, now and after every change.
  useEffect(() => {
    api.setBackgroundModel(model, effort, service).catch(() => {});
  }, [model, effort, service]);

  useEffect(() => {
    if (!open) return;
    loadLists();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (svc: AiService, m: string | null, e: string | null) => {
    setService(svc);
    setModel(m);
    setEffort(e);
    try {
      localStorage.setItem(SERVICE_KEY, svc);
      if (m) localStorage.setItem(MODEL_KEY, m);
      else localStorage.removeItem(MODEL_KEY);
      if (e) localStorage.setItem(EFFORT_KEY, e);
      else localStorage.removeItem(EFFORT_KEY);
    } catch {
      /* storage unavailable */
    }
    setOpen(false);
  };

  const row = (active: boolean) =>
    `w-full flex items-center gap-2 px-2.5 py-0.5 rounded text-left text-xs hover:bg-[var(--card)] ${active ? 'text-[var(--primary-text)]' : 'text-[var(--foreground)]'}`;

  return (
    <div ref={ref} className="relative h-full">
      <button
        className={`h-full px-3 flex items-center gap-1.5 text-xs hover:bg-[var(--card)] ${open ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}
        title={`Background worker: ${shown}. Bishop uses this model and reasoning level to do its work in the background, such as importing and refining tasks.`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {shown} <CaretDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 w-80 max-h-[70vh] overflow-y-auto p-1 rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-lg"
        >
          {!models?.length && (
            <div className="px-2.5 py-2 text-xs text-[var(--muted-foreground)]">{models ? 'No models found.' : 'Loading models...'}</div>
          )}
          {models?.map((m) => {
            const on = model === m.id && service === m.service;
            return (
            <div key={`${m.service}:${m.id}`} className="mt-0.5 pt-0.5 border-t border-[var(--border)]">
              <button role="menuitem" className={row(on && !effort)} onClick={() => choose(m.service, m.id, null)}>
                <span className="w-3.5">{on && !effort && <Check size={12} />}</span>
                <span className="font-medium">{m.label}</span>
                <span className="text-[var(--muted-foreground)]">default reasoning</span>
              </button>
              {m.efforts.map((lvl) => (
                <button key={lvl} role="menuitem" className={`${row(on && effort === lvl)} pl-8`} onClick={() => choose(m.service, m.id, lvl)}>
                  <span className="w-3.5">{on && effort === lvl && <Check size={12} />}</span>
                  {lvl}
                </button>
              ))}
            </div>
            );
          })}
        </div>
      )}
    </div>
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
