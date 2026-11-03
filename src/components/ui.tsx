import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, X } from './icons';
import { useBishopStore } from '../store/useBishopStore';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div className="min-w-44 py-1 rounded-md border border-[var(--border)] bg-[var(--card)] shadow-xl text-sm">
      {items.map((item, i) => (
        <div key={i} className="relative" onMouseEnter={() => setOpenSub(item.children ? i : null)}>
          <button
            disabled={item.disabled}
            className={`w-full flex items-center justify-between gap-4 px-3 py-1.5 text-left disabled:opacity-40 hover:bg-[var(--primary)] hover:text-[var(--primary-foreground)] ${
              item.danger ? 'text-red-400' : ''
            }`}
            onClick={() => {
              if (item.children) return setOpenSub(i);
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="truncate">{item.label}</span>
            {item.children && <ChevronRight size={13} />}
          </button>
          {item.children && openSub === i && (
            <div className="absolute left-full top-0 -mt-1 max-h-80 overflow-y-auto">
              <MenuList items={item.children} onClose={onClose} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Fixed-position context menu; closes on outside click, Escape, or selection. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="fixed z-[60]" style={{ left: x, top: y }}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}

/** Text input that commits on Enter/blur and cancels on Escape. */
export function InlineInput({
  initial = '',
  placeholder,
  onCommit,
  onCancel,
  className = '',
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (commit && v && v !== initial) onCommit(v);
    else onCancel();
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className={`w-full px-2 py-1 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text ${className}`}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function ConfirmDialog() {
  const request = useBishopStore((s) => s.confirmRequest);
  // Focus starts on Cancel so a stray Enter never deletes anything.
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    // Capture phase so Escape doesn't also close dialogs underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        request.resolve(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request]);

  if (!request) return null;
  return (
    <div className="fixed inset-0 z-[65] bg-black/50 grid place-items-center p-6" onMouseDown={() => request.resolve(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        data-testid="confirm-dialog"
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl p-5 flex flex-col gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-base font-semibold">
          {request.title}
        </h2>
        <p className="text-sm text-[var(--muted-foreground)] break-words">{request.message}</p>
        <div className="flex justify-end gap-2 pt-2">
          <button ref={cancelRef} className="px-3 py-1.5 text-sm rounded border border-[var(--border)] hover:bg-[var(--card)]" onClick={() => request.resolve(false)}>
            Cancel
          </button>
          <button className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-500" onClick={() => request.resolve(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useBishopStore();
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`flex items-start gap-3 max-w-sm px-3 py-2 rounded-md border text-sm shadow-lg ${
            t.kind === 'info' ? 'border-[var(--primary)] bg-[var(--card)] text-[var(--foreground)]' : 'border-red-800 bg-red-950/90 text-red-100'
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button onClick={() => dismissToast(t.id)} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/50 grid place-items-center p-6" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl max-h-full overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
