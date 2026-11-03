import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ImageIcon, Loader2, Mic, Plus, Trash2, UploadSimple } from './icons';
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
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { bySortOrder, useBishopStore } from '../store/useBishopStore';
import { CATEGORIES, MAX_TAGLINE_LENGTH, type Category, type Project, type Topic } from '../types';
import { CATEGORY_ACCENTS, CATEGORY_DOTS, CATEGORY_LABELS } from './categories';
import { InlineInput } from './ui';
import { VoiceTopic } from './VoiceTopic';
import { BishopLogo } from './BishopLogo';

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

function TopicCard({ topic }: { topic: Topic }) {
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
      className={`${cardClass} cursor-grab active:cursor-grabbing hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)] transition-colors ${
        pending ? 'opacity-60' : ''
      } ${isDragging ? 'opacity-30' : ''}`}
      onClick={() => !pending && openTopic(topic.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !pending) openTopic(topic.id);
        else listeners?.onKeyDown?.(e);
      }}
    >
      <TopicCardBody topic={topic} onCategory={(category) => moveTopic(topic.id, category, Number.MAX_SAFE_INTEGER)} />
    </div>
  );
}

function Column({ category, topics }: { category: Category; topics: Topic[] }) {
  const { createTopic } = useBishopStore();
  const [adding, setAdding] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: category });

  return (
    <section
      data-testid={`column-${category}`}
      className={`flex flex-col min-w-0 rounded-lg border border-[var(--border)] border-t-2 ${CATEGORY_ACCENTS[category]} bg-[var(--sidebar)] ${
        isOver ? 'ring-1 ring-[var(--primary)]' : ''
      }`}
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {CATEGORY_LABELS[category]} <span className="ml-1 tabular-nums">{topics.length}</span>
        </h2>
        <button className="p-1 rounded hover:bg-[var(--card)]" title="Add topic" onClick={() => setAdding(true)}>
          <Plus size={14} />
        </button>
      </header>
      <div ref={setNodeRef} className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-2 min-h-16">
        <SortableContext items={topics.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {topics.map((t) => (
            <TopicCard key={t.id} topic={t} />
          ))}
        </SortableContext>
        {adding ? (
          <InlineInput
            placeholder="Topic title"
            onCommit={(title) => {
              setAdding(false);
              createTopic(title, category);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            className="text-left text-xs px-2 py-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={() => setAdding(true)}
          >
            + Add topic
          </button>
        )}
      </div>
    </section>
  );
}

function buildColumns(topics: Topic[]): Columns {
  const cols = { RIGHT_NOW: [], SOON: [], LATER: [], BACKLOG: [] } as Columns;
  for (const t of [...topics].sort(bySortOrder)) cols[t.category].push(t.id);
  return cols;
}

function Board({ topics }: { topics: Topic[] }) {
  const moveTopic = useBishopStore((s) => s.moveTopic);
  const base = useMemo(() => buildColumns(topics), [topics]);
  // While dragging, a local copy of the columns tracks where the card currently sits.
  const [dragCols, setDragCols] = useState<Columns | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const columns = dragCols ?? base;
  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const isColumn = (id: UniqueIdentifier) => (CATEGORIES as readonly UniqueIdentifier[]).includes(id);
  const containerOf = (cols: Columns, id: UniqueIdentifier): Category | undefined =>
    isColumn(id) ? (id as Category) : CATEGORIES.find((c) => cols[c].includes(Number(id)));

  // Collision strategy for multiple sortable columns (after dnd-kit's MultipleContainers
  // example): prefer what's under the pointer, pick the closest card inside a column, and
  // hold the last target while the layout settles so moving between columns can't loop.
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewColumn = useRef(false);
  const collision: CollisionDetection = useCallback(
    (args) => {
      const pointerHits = pointerWithin(args);
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
      let overId = getFirstCollision(hits, 'id');
      if (overId != null) {
        if (isColumn(overId)) {
          const ids = columns[overId as Category];
          if (ids.length > 0) {
            overId =
              closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => c.id !== overId && ids.includes(Number(c.id))),
              })[0]?.id ?? overId;
          }
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (movedToNewColumn.current) lastOverId.current = activeId;
      return lastOverId.current != null ? [{ id: lastOverId.current }] : [];
    },
    [activeId, columns],
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      movedToNewColumn.current = false;
    });
  }, [dragCols]);

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(Number(active.id));
    setDragCols(base);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const cols = dragCols ?? base;
    const from = containerOf(cols, active.id);
    const to = containerOf(cols, over.id);
    if (!from || !to || from === to) return;
    const id = Number(active.id);
    const target = cols[to].filter((x) => x !== id);
    const overIndex = target.indexOf(Number(over.id));
    // Dropping below the hovered card's midpoint inserts after it.
    const translated = active.rect.current.translated;
    const below = translated != null && translated.top > over.rect.top + over.rect.height / 2;
    target.splice(overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length, 0, id);
    movedToNewColumn.current = true;
    setDragCols({ ...cols, [from]: cols[from].filter((x) => x !== id), [to]: target });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const cols = dragCols ?? base;
    setDragCols(null);
    setActiveId(null);
    const id = Number(active.id);
    const container = containerOf(cols, active.id);
    if (!over || !container) return;
    let items = cols[container];
    const oldIndex = items.indexOf(id);
    const overIndex = items.indexOf(Number(over.id));
    if (overIndex >= 0 && overIndex !== oldIndex) items = arrayMove(items, oldIndex, overIndex);
    const index = items.indexOf(id);
    const topic = byId.get(id);
    if (topic && (topic.category !== container || base[container].indexOf(id) !== index)) moveTopic(id, container, index);
  };

  const active = activeId !== null ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragCols(null);
        setActiveId(null);
      }}
    >
      <div className="flex-1 grid grid-cols-4 gap-3 min-h-0">
        {CATEGORIES.map((cat) => (
          <Column key={cat} category={cat} topics={columns[cat].map((id) => byId.get(id)!).filter(Boolean)} />
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

const overlayButton =
  'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-black/70 text-white border border-white/15 hover:bg-[var(--primary)] hover:border-[var(--primary)]';

/** The project picture, or a dashed "Add picture" zone that only shows on hover/drag. */
function ProjectPicture({ project, onFile, dragOver }: { project: Project; onFile: (f: File) => void; dragOver: boolean }) {
  const { uploadingImage, removeProjectImage, confirm } = useBishopStore();
  const input = useRef<HTMLInputElement>(null);
  const uploading = uploadingImage.includes(project.id);
  const pick = () => input.current?.click();
  const box = 'relative w-full sm:w-72 h-44 shrink-0 rounded-md overflow-hidden';
  const spinner = uploading && (
    <div className="absolute inset-0 grid place-items-center bg-black/50 text-white">
      <Loader2 size={22} className="animate-spin" />
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
        <div data-testid="project-picture" className={`group/pic ${box} border border-[var(--border)] bg-[var(--card)]`}>
          <img src={api.projectImageUrl(project.id, project.imageVersion)} alt={`${project.name} picture`} draggable={false} className="w-full h-full object-cover" />
          <div className="absolute inset-0 flex items-end justify-end gap-2 p-2 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/pic:opacity-100 focus-within:opacity-100 transition-opacity">
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
          className={`${box} border-2 border-dashed flex flex-col items-center justify-center gap-1.5 text-xs transition ${
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

/** Top-of-page panel: title, tagline and a summary on the left, the project picture on the right. */
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
      className={`group/overview flex flex-wrap-reverse gap-5 rounded-lg border bg-[var(--sidebar)] p-4 transition-colors ${
        dragOver ? 'border-[var(--primary)]' : 'border-[var(--border)]'
      }`}
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

        <div className="flex flex-wrap items-center gap-2" data-testid="overview-counts">
          {CATEGORIES.map((c) => {
            const n = topics.filter((t) => t.category === c).length;
            return (
              <span
                key={c}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[var(--border)] bg-[var(--card)] text-xs ${n === 0 ? 'opacity-50' : ''}`}
              >
                <span className={`w-2 h-2 rounded-full ${CATEGORY_DOTS[c]}`} />
                {CATEGORY_LABELS[c]}
                <span className="tabular-nums font-semibold">{n}</span>
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]" data-testid="overview-progress">
          <div className="h-1.5 w-40 rounded bg-[var(--card)] overflow-hidden">
            <div className="h-full bg-[var(--primary)] transition-[width]" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
          </div>
          <span className="tabular-nums">
            {tasks.length ? `${done}/${tasks.length} tasks done` : 'No tasks yet'}
          </span>
        </div>

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
    <div className="flex-1 flex flex-col overflow-hidden p-5 gap-4">
      <OverviewPanel project={project} topics={topics} onVoice={() => setVoiceOpen(true)} />
      {voiceOpen && <VoiceTopic onClose={() => setVoiceOpen(false)} />}
      <Board topics={topics} />
    </div>
  );
}
