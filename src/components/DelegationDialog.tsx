import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from './icons';
import { useBishopStore } from '../store/useBishopStore';
import { api } from '../api/client';
import { complexityColor, complexityTextColor, DEFAULT_EFFORT, DEFAULT_MODEL, effortLabel, levelsOf, type DelegationChoice, type DelegationConfig } from '../types';

/** The agents a complexity level can be delegated to. */
type DelegationMode = 'claude' | 'antigravity';

const MODES: { id: DelegationMode; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'antigravity', label: 'Antigravity' },
];

const NO_CHOICE: DelegationChoice = { model: null, effort: null };
const INTENSITIES = Array.from({ length: 10 }, (_, i) => i + 1);

/** Complexity delegation pop-up, opened from the Delegation button in the title bar. Close with the X, Esc or a click outside. */
export function DelegationDialog() {
  const { delegationOpen, setDelegationOpen } = useBishopStore();
  const { aiModelLists, loadAiModels, pushError } = useBishopStore();
  const [mode, setModeState] = useState<DelegationMode>('claude');
  // Per mode and intensity. Nothing is chosen until the user picks a model: rows show the CLI's defaults.
  const [choices, setChoices] = useState<Record<DelegationMode, Partial<Record<number, DelegationChoice>>>>({ claude: {}, antigravity: {} });
  // Rows can't be edited until the saved setup is read, or a save could overwrite it with blanks.
  const [loaded, setLoaded] = useState(false);
  const latest = useRef<DelegationConfig | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const toConfig = (m: DelegationMode, c: typeof choices): DelegationConfig => {
    const pack = (rows: Partial<Record<number, DelegationChoice>>) =>
      Object.fromEntries(Object.entries(rows).filter(([, v]) => v && (v.model || v.effort))) as Record<string, DelegationChoice>;
    return { mode: m, choices: { claude: pack(c.claude), antigravity: pack(c.antigravity) } };
  };
  /** Saves after each change, one request at a time and in order, so the last edit wins. */
  const save = (m: DelegationMode, c: typeof choices) => {
    const config = toConfig(m, c);
    latest.current = config;
    saving.current = saving.current
      .catch(() => {})
      .then(() => api.saveDelegationConfig(config))
      .catch(pushError);
  };
  const setMode = (m: DelegationMode) => {
    setModeState(m);
    save(m, choices);
  };
  const update = (next: (c: typeof choices) => typeof choices) => {
    const c = next(choices);
    setChoices(c);
    save(mode, c);
  };
  const models = aiModelLists[mode];
  /** The non-premium reasoning levels a model takes. No model: the levels any listed model takes. */
  const levelsFor = (model: string | null) => levelsOf(models ?? [], model);
  const setModel = (n: number, model: string | null) =>
    update((c) => {
      const prev = c[mode][n] ?? NO_CHOICE;
      // A level the new model doesn't take is dropped, back to the CLI default.
      const effort = prev.effort && levelsFor(model).includes(prev.effort) ? prev.effort : null;
      return { ...c, [mode]: { ...c[mode], [n]: { model, effort } } };
    });
  const setEffort = (n: number, effort: string | null) =>
    update((c) => ({ ...c, [mode]: { ...c[mode], [n]: { ...(c[mode][n] ?? NO_CHOICE), effort } } }));

  // Read the saved setup each time the dialog opens.
  useEffect(() => {
    if (!delegationOpen) return;
    let stale = false;
    setLoaded(false);
    api
      .delegationConfig()
      .then((cfg) => {
        if (stale) return;
        const rows = (m: DelegationMode) =>
          Object.fromEntries(Object.entries(cfg.choices?.[m] ?? {}).map(([k, v]) => [Number(k), v])) as Partial<Record<number, DelegationChoice>>;
        setModeState(cfg.mode === 'antigravity' ? 'antigravity' : 'claude');
        setChoices({ claude: rows('claude'), antigravity: rows('antigravity') });
        setLoaded(true);
      })
      .catch((e) => {
        if (!stale) pushError(e);
      });
    return () => {
      stale = true;
    };
  }, [delegationOpen, pushError]);

  useEffect(() => {
    if (delegationOpen && !models) loadAiModels(mode);
  }, [delegationOpen, mode, models, loadAiModels]);

  useEffect(() => {
    if (!delegationOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDelegationOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [delegationOpen, setDelegationOpen]);

  if (!delegationOpen) return null;

  const close = () => setDelegationOpen(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-center p-6" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Complexity delegation"
        data-testid="delegation-dialog"
        className="w-full max-w-2xl h-[70vh] flex flex-col rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 h-11 shrink-0 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles size={16} className="text-[var(--muted-foreground)]" /> Complexity delegation
          </div>
          <button
            aria-label="Close"
            title="Close"
            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-auto p-4 text-sm text-[var(--muted-foreground)]">
          <div role="radiogroup" aria-label="Agent" className="inline-flex self-start p-0.5 rounded-md border border-[var(--border)] bg-[var(--card)]">
            {MODES.map((m) => {
              const selected = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`delegation-mode-${m.id}`}
                  className={`px-3 py-1 rounded text-sm ${
                    selected
                      ? 'bg-[var(--sidebar)] text-[var(--foreground)] shadow-sm font-medium'
                      : 'hover:text-[var(--foreground)]'
                  }`}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <div>
            The {MODES.find((m) => m.id === mode)?.label} model and reasoning level used for tasks at each intensity. Saved as an app setting, for all projects.
          </div>
          <ul className="flex flex-col gap-1.5" aria-label="Intensities" data-testid="delegation-rows">
            {INTENSITIES.map((n) => {
              const choice = choices[mode][n] ?? NO_CHOICE;
              const known = !choice.model || !!models?.some((m) => m.id === choice.model);
              const levels = levelsFor(choice.model);
              return (
                <li
                  key={n}
                  data-testid={`delegation-row-${n}`}
                  className="flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--card)]"
                >
                  <span
                    className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
                    style={{ backgroundColor: complexityColor(n), color: complexityTextColor(n) }}
                    title={`Intensity ${n}`}
                  >
                    {n}
                  </span>
                  <select
                    aria-label={`Model for intensity ${n}`}
                    data-testid={`delegation-model-${n}`}
                    value={choice.model ?? ''}
                    disabled={!loaded}
                    onChange={(e) => setModel(n, e.target.value || null)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 truncate rounded border border-[var(--border)] bg-[var(--sidebar)] text-[var(--foreground)] text-sm px-2 py-1 outline-none focus:border-[var(--primary)]"
                  >
                    <option value="">{DEFAULT_MODEL}</option>
                    {!known && <option value={choice.model!}>{choice.model}</option>}
                    {models?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Reasoning level for intensity ${n}`}
                    data-testid={`delegation-effort-${n}`}
                    value={choice.effort ?? ''}
                    disabled={!loaded}
                    onChange={(e) => setEffort(n, e.target.value || null)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="w-40 shrink-0 truncate rounded border border-[var(--border)] bg-[var(--sidebar)] text-[var(--foreground)] text-sm px-2 py-1 outline-none focus:border-[var(--primary)]"
                  >
                    <option value="">{DEFAULT_EFFORT}</option>
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {effortLabel(l)}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
