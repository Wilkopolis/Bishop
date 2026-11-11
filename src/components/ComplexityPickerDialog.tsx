import { useEffect } from 'react';
import { X } from './icons';
import { useBishopStore } from '../store/useBishopStore';
import { complexityColor, complexityTextColor } from '../types';

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Complexity picker, opened from a task's complexity bubble in the topic view. Close with the X, Esc or a click outside. */
export function ComplexityPickerDialog() {
  const taskId = useBishopStore((s) => s.complexityPickerTaskId);
  const openComplexityPicker = useBishopStore((s) => s.openComplexityPicker);
  const task = useBishopStore((s) => (s.complexityPickerTaskId === null ? null : s.topics.flatMap((t) => t.tasks).find((t) => t.id === s.complexityPickerTaskId) ?? null));
  const setTaskComplexity = useBishopStore((s) => s.setTaskComplexity);

  useEffect(() => {
    if (taskId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openComplexityPicker(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, openComplexityPicker]);

  if (taskId === null || !task) return null;

  const close = () => openComplexityPicker(null);
  const selected = task.complexity;
  const pick = (n: number) => {
    if (n !== task.complexity) void setTaskComplexity(task.id, n);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-center p-6" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Task complexity"
        data-testid="complexity-picker"
        className="w-full max-w-sm flex flex-col rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 h-11 shrink-0 border-b border-[var(--border)]">
          <div className="text-sm font-medium">Task complexity</div>
          <button
            aria-label="Close"
            title="Close"
            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 flex flex-col gap-3 text-sm text-[var(--muted-foreground)]">
          <div className="truncate" title={task.title}>{task.title}</div>
          <ul role="radiogroup" aria-label="Complexity" className="flex flex-col gap-1.5" data-testid="complexity-picker-levels">
            {LEVELS.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === n}
                  data-testid={`complexity-level-${n}`}
                  className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-md border bg-[var(--card)] text-left hover:border-[var(--primary)] ${
                    selected === n ? 'border-[var(--primary)] text-[var(--foreground)]' : 'border-[var(--border)]'
                  }`}
                  onClick={() => pick(n)}
                >
                  <span
                    className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
                    style={{ backgroundColor: complexityColor(n), color: complexityTextColor(n) }}
                  >
                    {n}
                  </span>
                  <span>Level {n}{task.complexity === n ? ' (current)' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
