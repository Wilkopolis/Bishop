import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Mic, Plus } from 'lucide-react';
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
import { CATEGORIES, type Category, type Topic } from '../types';
import { CATEGORY_ACCENTS, CATEGORY_LABELS } from './categories';
import { InlineInput } from './ui';
import { VoiceTopic } from './VoiceTopic';

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
              <div className="h-full bg-emerald-500" style={{ width: `${(done / total) * 100}%` }} />
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

export function ProjectOverview() {
  const { projects, selectedProjectId, topics } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);
  const [voiceOpen, setVoiceOpen] = useState(false);

  if (!project) {
    return <div className="flex-1 grid place-items-center text-sm text-[var(--muted-foreground)]">Select or create a project.</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-5 gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold truncate">{project.name}</h1>
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-110"
          title="Record a voice note and turn it into a topic"
          onClick={() => setVoiceOpen(true)}
        >
          <Mic size={15} /> Voice topic
        </button>
      </div>
      {voiceOpen && <VoiceTopic onClose={() => setVoiceOpen(false)} />}
      <Board topics={topics} />
    </div>
  );
}
