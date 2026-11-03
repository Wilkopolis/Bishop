import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, ImageIcon, Loader2, Mic, Plus, Trash2, UploadSimple } from './icons';
import { api } from '../api/client';
import { imageFromDataTransfer, PICTURE_ACCEPT } from '../images';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { bySortOrder, useBishopStore } from '../store/useBishopStore';
import { CATEGORIES, MAX_TAGLINE_LENGTH, type Category, type Project, type Topic } from '../types';
import { CATEGORY_DOTS, CATEGORY_LABELS } from './categories';
import { InlineInput } from './ui';
import { VoiceTopic } from './VoiceTopic';
import { BishopLogo } from './BishopLogo';
import { FolderBanner, FolderLine } from './ProjectFolder';

type Columns = Record<Category, number[]>;

export function CategorySelect({ value, onChange, className = '' }: { value: Category; onChange: (c: Category) => void; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Category)}
      onClick={(e) => e.stopPropagation()}
      // Keep the dropdown usable inside draggable cards.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={`rounded border border-[var(--border)] bg-[var(--sidebar)] text-xs px-1 py-0.5 outline-none focus:border-[var(--primary)] ${className}`}
    >
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {CATEGORY_LABELS[c]}
        </option>
      ))}
    </select>
  );
}

function TopicCardBody({ topic, onCategory }: { topic: Topic; onCategory?: (c: Category) => void }) {
  const done = topic.tasks.filter((t) => t.completed).length;
  const total = topic.tasks.length;
  return (
    <>
      <div className="text-sm font-medium break-words">{topic.title}</div>
      {topic.description && <div className="mt-1 text-xs text-[var(--muted-foreground)] line-clamp-2 break-words">{topic.description}</div>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {total > 0 && (
            <div className="h-1 w-12 min-w-2 shrink rounded bg-[var(--sidebar)] overflow-hidden">
              <div className="h-full bg-[var(--primary)]" style={{ width: `${(done / total) * 100}%` }} />
            </div>
          )}
          <span className="shrink-0 text-xs text-[var(--muted-foreground)] tabular-nums">
            {done}/{total}
          </span>
        </div>
        {onCategory ? <CategorySelect value={topic.category} onChange={onCategory} /> : <span className="text-xs">{CATEGORY_LABELS[topic.category]}</span>}
      </div>
    </>
  );
}

const cardClass = 'rounded-md border border-[var(--border)] bg-[var(--card)] p-3';

function TopicCard({ topic, hint }: { topic: Topic; hint?: 'before' | 'after' }) {
  const { openTopic, moveTopic } = useBishopStore();
  const pending = topic.id < 0;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: topic.id, disabled: pending });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid="topic-card"
      data-topic-id={topic.id}
      aria-label={`${topic.title}. Press Space to pick up and move with arrow keys, Enter to open.`}
      className={`${cardClass} relative cursor-grab active:cursor-grabbing hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)] transition-colors ${
        pending ? 'opacity-60' : ''
      } ${isDragging ? 'opacity-30' : ''}`}
      onClick={() => !pending && openTopic(topic.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !pending) openTopic(topic.id);
        else listeners?.onKeyDown?.(e);
      }}
    >
      {hint && (
        <div
          data-testid="drop-hint"
          className={`absolute top-1 bottom-1 w-1 rounded bg-[var(--primary)] ${hint === 'before' ? '-left-1.5' : '-right-1.5'}`}
        />
      )}
      <TopicCardBody topic={topic} onCategory={(category) => moveTopic(topic.id, category, Number.MAX_SAFE_INTEGER)} />
    </div>
  );
}

type CollapsedMap = Partial<Record<Category, boolean>>;

const collapsedKey = (projectId: number) => `bishop_collapsed_${projectId}`;

function readCollapsed(projectId: number): CollapsedMap {
  try {
    const raw = localStorage.getItem(collapsedKey(projectId));
    return raw ? (JSON.parse(raw) as CollapsedMap) : {};
  } catch {
    return {};
  }
}

/** One category, stacked: a header row, then its cards in a wrapping grid. */
function Section({
  category,
  topics,
  collapsed,
  onToggle,
  hint,
}: {
  category: Category;
  topics: Topic[];
  collapsed: boolean;
  onToggle: () => void;
  hint: DropHint | null;
}) {
  const { createTopic } = useBishopStore();
  const [adding, setAdding] = useState(false);
  // Expanded: the grid is the drop target. Collapsed: the header is (dropping appends).
  const { setNodeRef, isOver } = useDroppable({ id: category });

  return (
    <section data-testid={`column-${category}`} aria-label={CATEGORY_LABELS[category]} className="flex flex-col gap-2">
      <header
        ref={collapsed ? setNodeRef : undefined}
        className={`flex items-center gap-2 py-1.5 border-b transition-colors ${
          collapsed && isOver ? 'border-[var(--primary)] bg-[var(--primary-subtle)]' : 'border-[var(--border)]'
        }`}
      >
        <button
          className="flex items-center gap-2 rounded px-1 -ml-1 hover:text-[var(--foreground)] text-[var(--muted-foreground)]"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={onToggle}
        >
          <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <span className={`w-2.5 h-2.5 rounded-full ${CATEGORY_DOTS[category]}`} />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">{CATEGORY_LABELS[category]}</h2>
          <span className="text-xs tabular-nums">{topics.length}</span>
        </button>
        <div className="flex-1" />
        <button
          className="p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]"
          title={`Add topic to ${CATEGORY_LABELS[category]}`}
          onClick={() => {
            if (collapsed) onToggle();
            setAdding(true);
          }}
        >
          <Plus size={14} />
        </button>
      </header>
      {!collapsed && (
        <div
          ref={setNodeRef}
          className={`grid gap-2 grid-cols-[repeat(auto-fill,minmax(260px,1fr))] rounded-md transition-colors ${
            isOver ? 'bg-[var(--primary-subtle)]' : ''
          }`}
        >
          <SortableContext items={topics.map((t) => t.id)} strategy={rectSortingStrategy}>
            {topics.map((t) => (
              <TopicCard key={t.id} topic={t} hint={hint?.cardId === t.id ? (hint.after ? 'after' : 'before') : undefined} />
            ))}
          </SortableContext>
          {adding ? (
            <div className="self-start">
              <InlineInput
                placeholder="Topic title"
                onCommit={(title) => {
                  setAdding(false);
                  createTopic(title, category);
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : (
            <button
              className="min-h-10 text-left text-xs px-3 py-2 rounded-md border border-dashed border-transparent text-[var(--muted-foreground)] hover:border-[var(--border)] hover:text-[var(--foreground)]"
              onClick={() => setAdding(true)}
            >
              + Add topic
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Where a card dragged in from another section will land: next to a card, or at the end. */
type DropHint = { category: Category; cardId: number | null; after: boolean };

function buildColumns(topics: Topic[]): Columns {
  const cols = { RIGHT_NOW: [], SOON: [], LATER: [], BACKLOG: [] } as Columns;
  for (const t of [...topics].sort(bySortOrder)) cols[t.category].push(t.id);
  return cols;
}

/**
 * Drag and drop for the stacked sections.
 * - Within a section: dnd-kit sortable (the grid reflows live; the card takes the hovered card's place).
 * - Into another section: nothing reflows. An insertion bar shows on the hovered card's left/right
 *   edge (by pointer position) and the drop lands exactly there; empty areas and collapsed headers append.
 */
function Board({ topics, projectId }: { topics: Topic[]; projectId: number }) {
  const moveTopic = useBishopStore((s) => s.moveTopic);
  const columns = useMemo(() => buildColumns(topics), [topics]);
  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  const startColumn = useRef<Category | undefined>(undefined);

  // Collapsed sections, remembered per project (best effort; storage may be unavailable).
  const [collapsed, setCollapsed] = useState<CollapsedMap>(() => readCollapsed(projectId));
  useEffect(() => setCollapsed(readCollapsed(projectId)), [projectId]);
  const toggle = (c: Category) =>
    setCollapsed((prev) => {
      const next = { ...prev, [c]: !prev[c] };
      try {
        localStorage.setItem(collapsedKey(projectId), JSON.stringify(next));
      } catch {}
      return next;
    });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const isColumn = (id: UniqueIdentifier) => (CATEGORIES as readonly UniqueIdentifier[]).includes(id);
  const containerOf = (id: UniqueIdentifier): Category | undefined =>
    isColumn(id) ? (id as Category) : CATEGORIES.find((c) => columns[c].includes(Number(id)));

  // Prefer what's under the pointer; inside a section's empty space pick its closest card.
  const collision: CollisionDetection = useCallback(
    (args) => {
      const pointerHits = pointerWithin(args);
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
      const card = hits.find((h) => !isColumn(h.id));
      if (card) return [card];
      const overId = getFirstCollision(hits, 'id');
      if (overId == null) return [];
      const ids = columns[overId as Category] ?? [];
      const cards = args.droppableContainers.filter((c) => ids.includes(Number(c.id)));
      // Over a section's own empty space (same section): snap to its nearest card for sortable.
      if (cards.length > 0 && overId === startColumn.current) return closestCenter({ ...args, droppableContainers: cards });
      return [{ id: overId }];
    },
    [columns],
  );

  /** Pointer position for mouse/touch drags; null for keyboard drags. */
  const pointerAt = (e: DragMoveEvent | DragEndEvent): { x: number; y: number } | null => {
    const a = e.activatorEvent as PointerEvent;
    return typeof a?.clientX === 'number' ? { x: a.clientX + e.delta.x, y: a.clientY + e.delta.y } : null;
  };

  const computeHint = (e: DragMoveEvent | DragEndEvent): DropHint | null => {
    const { active, over } = e;
    if (!over) return null;
    const target = containerOf(over.id);
    if (!target || target === startColumn.current) return null;
    if (isColumn(over.id) || Number(over.id) === Number(active.id)) return { category: target, cardId: null, after: true };
    // Same row: left/right of the card's center; otherwise above/below.
    const p = pointerAt(e);
    const t = active.rect.current.translated;
    const x = p?.x ?? (t ? t.left + t.width / 2 : 0);
    const y = p?.y ?? (t ? t.top + t.height / 2 : 0);
    const r = over.rect;
    const sameRow = y >= r.top && y <= r.top + r.height;
    const after = sameRow ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    return { category: target, cardId: Number(over.id), after };
  };

  const reset = () => {
    setActiveId(null);
    setHint(null);
    startColumn.current = undefined;
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(Number(active.id));
    startColumn.current = containerOf(active.id);
  };

  const onDragMove = (e: DragMoveEvent) => {
    const next = computeHint(e);
    setHint((prev) =>
      prev?.category === next?.category && prev?.cardId === next?.cardId && prev?.after === next?.after ? prev : next,
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const id = Number(active.id);
    const from = startColumn.current;
    const dropHint = computeHint(e);
    reset();
    if (!over || !from) return;

    if (dropHint) {
      // Into another section, at the hinted spot.
      const list = columns[dropHint.category].filter((x) => x !== id);
      const index = dropHint.cardId == null ? list.length : list.indexOf(dropHint.cardId) + (dropHint.after ? 1 : 0);
      moveTopic(id, dropHint.category, index);
      return;
    }
    // Same section: sortable semantics, matching the live preview.
    const items = columns[from];
    const oldIndex = items.indexOf(id);
    const overIndex = items.indexOf(Number(over.id));
    if (overIndex >= 0 && overIndex !== oldIndex) moveTopic(id, from, arrayMove(items, oldIndex, overIndex).indexOf(id));
  };

  const active = activeId !== null ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <div className="flex flex-col gap-5 pb-6">
        {CATEGORIES.map((cat) => (
          <Section
            key={cat}
            category={cat}
            topics={columns[cat].map((id) => byId.get(id)!).filter(Boolean)}
            collapsed={!!collapsed[cat]}
            onToggle={() => toggle(cat)}
            hint={hint?.category === cat ? hint : null}
          />
        ))}
      </div>
      <DragOverlay>
        {active && (
          <div className={`${cardClass} shadow-2xl border-[var(--primary)] rotate-1 cursor-grabbing`}>
            <TopicCardBody topic={active} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** Tagline next to the project title: click to edit; Enter/blur saves, Escape cancels. */
function ProjectTagline({ project }: { project: Project }) {
  const { setProjectTagline, editingTagline, setEditingTagline } = useBishopStore();
  const [value, setValue] = useState('');
  // Enter, Escape and blur can all end an edit; only the first one counts.
  const done = useRef(false);

  useEffect(() => {
    if (editingTagline) {
      done.current = false;
      setValue(project.tagline ?? '');
    }
  }, [editingTagline, project.id]);

  if (editingTagline) {
    const finish = (save: boolean) => {
      if (done.current) return;
      done.current = true;
      setEditingTagline(false);
      if (!save) return;
      const next = value.trim() || null;
      if (next !== (project.tagline ?? null)) setProjectTagline(project.id, next);
    };
    return (
      <div className="flex items-center gap-2 flex-1 basis-60 min-w-60">
        <input
          autoFocus
          aria-label="Project tagline"
          maxLength={MAX_TAGLINE_LENGTH}
          placeholder="A short tagline for this project"
          className="flex-1 min-w-0 px-2 py-1 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
          }}
          onBlur={() => finish(true)}
        />
        <span className={`shrink-0 text-xs tabular-nums ${value.length >= MAX_TAGLINE_LENGTH ? 'text-[var(--primary-text)]' : 'text-[var(--muted-foreground)]'}`}>
          {value.length}/{MAX_TAGLINE_LENGTH}
        </span>
      </div>
    );
  }

  return project.tagline ? (
    <button
      data-testid="project-tagline"
      title={project.tagline}
      className="flex-1 basis-60 min-w-60 text-left truncate text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded"
      onClick={() => setEditingTagline(true)}
    >
      {project.tagline}
    </button>
  ) : (
    <button
      data-testid="project-tagline-add"
      className="flex-1 basis-60 min-w-60 text-left text-sm text-[var(--muted-foreground)] opacity-0 group-hover/title:opacity-60 focus-visible:opacity-60 transition-opacity rounded"
      onClick={() => setEditingTagline(true)}
    >
      Add a tagline
    </button>
  );
}

// The picture dissolves into the page on every side: a strong fade on the left (toward the
// text), softer fades top, bottom and right. The two gradients are intersected.
const pictureFadeMask: CSSProperties = (() => {
  const image = [
    'linear-gradient(to right, transparent 0%, #000 42%, #000 86%, transparent 100%)',
    'linear-gradient(to bottom, transparent 0%, #000 22%, #000 70%, transparent 100%)',
  ].join(', ');
  return { maskImage: image, WebkitMaskImage: image, maskComposite: 'intersect', WebkitMaskComposite: 'source-in' };
})();

const overlayButton =
  'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-black/70 text-white border border-white/15 hover:bg-[var(--primary)] hover:border-[var(--primary)]';

/** The project picture, or a dashed "Add picture" zone that only shows on hover/drag. */
function ProjectPicture({ project, onFile, dragOver }: { project: Project; onFile: (f: File) => void; dragOver: boolean }) {
  const { uploadingImage, removeProjectImage, confirm } = useBishopStore();
  const input = useRef<HTMLInputElement>(null);
  const uploading = uploadingImage.includes(project.id);
  const pick = () => input.current?.click();
  const box = 'relative w-full sm:w-80 h-48 shrink-0';
  const spinner = uploading && (
    <div className="absolute inset-0 grid place-items-center text-[var(--primary-text)]">
      <Loader2 size={24} className="animate-spin" />
    </div>
  );

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={PICTURE_ACCEPT}
        className="hidden"
        data-testid="picture-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      {project.imageVersion ? (
        <div data-testid="project-picture" className={`group/pic ${box}`}>
          <img
            src={api.projectImageUrl(project.id, project.imageVersion)}
            alt={`${project.name} picture`}
            draggable={false}
            className={`w-full h-full object-cover transition-opacity ${uploading ? 'opacity-40' : ''}`}
            style={pictureFadeMask}
          />
          {/* Controls sit outside the mask so they stay crisp. */}
          <div className="absolute inset-0 flex items-end justify-end gap-2 p-3 opacity-0 group-hover/pic:opacity-100 focus-within:opacity-100 transition-opacity">
            <button className={overlayButton} onClick={pick}>
              <UploadSimple size={13} /> Replace
            </button>
            <button
              className={overlayButton}
              onClick={async () => {
                if (await confirm({ title: 'Remove picture?', message: `The picture for "${project.name}" will be removed.`, confirmLabel: 'Remove' }))
                  removeProjectImage(project.id);
              }}
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
          {spinner}
        </div>
      ) : (
        <button
          data-testid="project-picture-add"
          onClick={pick}
          className={`${box} rounded-md border-2 border-dashed flex flex-col items-center justify-center gap-1.5 text-xs transition ${
            dragOver || uploading
              ? 'opacity-100 border-[var(--primary)] text-[var(--foreground)] bg-[var(--primary-subtle)]'
              : 'opacity-0 group-hover/overview:opacity-100 focus-visible:opacity-100 border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)] hover:text-[var(--foreground)]'
          }`}
        >
          <ImageIcon size={22} />
          <span className="text-sm">Add picture</span>
          <span className="opacity-70">Click, drop or paste an image</span>
          {spinner}
        </button>
      )}
    </>
  );
}

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Top-of-page panel: title, tagline and task progress on the left, the project picture on the right. */
function OverviewPanel({ project, topics, onVoice }: { project: Project; topics: Topic[]; onVoice: () => void }) {
  const setProjectImage = useBishopStore((s) => s.setProjectImage);
  const [dragOver, setDragOver] = useState(false);
  const tasks = topics.flatMap((t) => t.tasks);
  const done = tasks.filter((t) => t.completed).length;
  const onFile = (f: File) => setProjectImage(project.id, f);

  // Paste an image anywhere on the page (outside text fields and dialogs) to set the picture.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('[data-testid=topic-detail], [data-testid=voice-topic], [data-testid=search-dialog], [data-testid=confirm-dialog]')) return;
      const f = imageFromDataTransfer(e.clipboardData);
      if (f) {
        e.preventDefault();
        setProjectImage(project.id, f);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [project.id, setProjectImage]);

  return (
    <section
      data-testid="overview"
      aria-label="Project overview"
      // No container: a soft wash from the top fades into the page, edge to edge.
      className="group/overview -mx-5 -mt-5 px-6 pt-6 pb-2 flex flex-wrap-reverse items-center gap-6"
      style={{
        backgroundImage: `linear-gradient(to bottom, ${dragOver ? 'var(--primary-subtle)' : 'var(--sidebar)'} 0%, transparent 100%)`,
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragOver(false);
        const f = imageFromDataTransfer(e.dataTransfer);
        if (f) onFile(f);
      }}
    >
      <div className="flex-1 basis-80 min-w-0 flex flex-col gap-3">
        <div className="group/title flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <h1 className="text-2xl font-semibold truncate max-w-full">{project.name}</h1>
          <ProjectTagline project={project} />
        </div>

        <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]" data-testid="overview-progress">
          <div className="h-1.5 w-40 rounded bg-[var(--card)] overflow-hidden">
            <div className="h-full bg-[var(--primary)] transition-[width]" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
          </div>
          <span className="tabular-nums">
            {tasks.length ? `${done}/${tasks.length} tasks done` : 'No tasks yet'}
          </span>
        </div>

        <FolderLine project={project} />

        <div className="mt-auto pt-1">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]"
            title="Record a voice note and turn it into a topic"
            onClick={onVoice}
          >
            <Mic size={15} /> Voice topic
          </button>
        </div>
      </div>
      <ProjectPicture project={project} onFile={onFile} dragOver={dragOver} />
    </section>
  );
}

export function ProjectOverview() {
  const { projects, selectedProjectId, topics } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);
  const [voiceOpen, setVoiceOpen] = useState(false);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-sm text-[var(--muted-foreground)]">
        <BishopLogo size={96} className="text-[var(--primary)] opacity-25" />
        Select or create a project.
      </div>
    );
  }

  return (
    // The whole page scrolls: the faded overview first, then the stacked category sections.
    <div className="flex-1 flex flex-col overflow-y-auto p-5 gap-4" data-testid="project-page">
      <OverviewPanel project={project} topics={topics} onVoice={() => setVoiceOpen(true)} />
      {(!project.folderPath || project.folderMissing) && <FolderBanner project={project} />}
      {voiceOpen && <VoiceTopic onClose={() => setVoiceOpen(false)} />}
      <Board topics={topics} projectId={project.id} />
    </div>
  );
}
