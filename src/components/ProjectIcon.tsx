import { useMemo, useState } from 'react';
import { useBishopStore } from '../store/useBishopStore';
import type { Project } from '../types';
import { NotebookText, Search, X } from './icons';
import { PROJECT_ICON_CATEGORIES, PROJECT_ICON_SVG, PROJECT_ICONS } from './projectIconData';
import { Modal } from './ui';

// Tints the user picks from. These are data, not theme colors.
const ICON_COLORS = [
  '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171',
  '#fb923c', '#facc15', '#fde047', '#a3e635', '#4ade80', '#34d399', '#2dd4bf', '#22d3ee', '#94a3b8',
];

function Glyph({ icon, color, size }: { icon: string | null; color?: string | null; size: number }) {
  const markup = icon ? PROJECT_ICON_SVG[icon] : undefined;
  const style = color ? { color } : undefined;
  if (!markup) return <NotebookText size={size} className="shrink-0" style={style} />;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      className="shrink-0"
      style={style}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** The project's icon, or the default notebook. `plain` drops the tint, for use on the orange selected row. */
export function ProjectIcon({ project, size = 14, plain = false }: { project: Project; size?: number; plain?: boolean }) {
  return <Glyph icon={project.icon} color={plain ? null : project.iconColor} size={size} />;
}

function Picker({ project, close }: { project: Project; close: () => void }) {
  const setProjectIcon = useBishopStore((s) => s.setProjectIcon);
  const [icon, setIcon] = useState(project.icon);
  const [color, setColor] = useState(project.iconColor);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PROJECT_ICONS.filter(
      (i) => (category === 'all' || i.category === category) && (!q || i.id.includes(q) || i.label.toLowerCase().includes(q)),
    );
  }, [query, category]);

  const save = (nextIcon: string | null, nextColor: string | null) => {
    setProjectIcon(project.id, nextIcon, nextColor);
    close();
  };

  const pill = (active: boolean) =>
    `px-2.5 py-1 rounded text-xs whitespace-nowrap ${
      active ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
    }`;

  return (
    <div data-testid="project-icon-dialog" className="p-5 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-md bg-[var(--card)] border border-[var(--border)] grid place-items-center shrink-0">
          <Glyph icon={icon} color={color} size={22} />
        </div>
        <h2 className="text-lg font-semibold truncate flex-1">Icon for {project.name}</h2>
        <button className="p-1 rounded hover:bg-[var(--card)]" title="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>

      <div className="relative flex items-center">
        <Search size={13} className="absolute left-2.5 text-[var(--muted-foreground)] pointer-events-none" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons"
          className="w-full pl-8 pr-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)]"
        />
      </div>

      <div className="flex flex-wrap gap-1">
        <button className={pill(category === 'all')} onClick={() => setCategory('all')}>All</button>
        {PROJECT_ICON_CATEGORIES.filter((c) => c.id !== 'all').map((c) => (
          <button key={c.id} className={pill(category === c.id)} onClick={() => setCategory(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-10 gap-1 p-2 h-52 content-start overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)]">
        {shown.map((i) => (
          <button
            key={i.id}
            title={i.label}
            aria-label={i.label}
            aria-pressed={icon === i.id}
            onClick={() => setIcon(i.id)}
            className={`h-9 rounded grid place-items-center ${icon === i.id ? 'bg-[var(--primary-subtle)] ring-2 ring-[var(--primary)]' : 'hover:bg-[var(--card)]'}`}
          >
            <Glyph icon={i.id} color={icon === i.id ? color : null} size={18} />
          </button>
        ))}
        {shown.length === 0 && <p className="col-span-10 py-8 text-center text-sm text-[var(--muted-foreground)]">No icons match.</p>}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          title="No tint"
          aria-label="No tint"
          aria-pressed={color === null}
          onClick={() => setColor(null)}
          className={`w-6 h-6 rounded border border-[var(--border)] bg-[var(--card)] grid place-items-center ${color === null ? 'ring-2 ring-[var(--primary)]' : ''}`}
        >
          <X size={11} />
        </button>
        {ICON_COLORS.map((hex) => (
          <button
            key={hex}
            title={hex}
            aria-label={`Tint ${hex}`}
            aria-pressed={color === hex}
            onClick={() => setColor(hex)}
            className={`w-6 h-6 rounded ${color === hex ? 'ring-2 ring-[var(--foreground)]' : ''}`}
            style={{ backgroundColor: hex }}
          />
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] cursor-pointer">
          Custom
          <input
            type="color"
            value={color ?? '#94a3b8'}
            onChange={(e) => setColor(e.target.value)}
            className="w-6 h-6 rounded border border-[var(--border)] bg-transparent cursor-pointer"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1.5 rounded text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          onClick={() => save(null, null)}
        >
          Use default
        </button>
        <button className="ml-auto px-3 py-1.5 rounded text-sm bg-[var(--card)] border border-[var(--border)]" onClick={close}>
          Cancel
        </button>
        <button
          className="px-3 py-1.5 rounded text-sm bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]"
          onClick={() => save(icon, color)}
        >
          Save icon
        </button>
      </div>
    </div>
  );
}

/** "Change icon…" from the sidebar menu. */
export function ProjectIconDialog() {
  const { iconDialogFor, setIconDialogFor, projects } = useBishopStore();
  const project = projects.find((p) => p.id === iconDialogFor);
  if (!project) return null;
  const close = () => setIconDialogFor(null);
  return (
    <Modal onClose={close}>
      <Picker key={project.id} project={project} close={close} />
    </Modal>
  );
}
