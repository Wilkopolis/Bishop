import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Archive, ArrowRight, ArrowUUpLeft, ChevronRight, GripVertical, ImageIcon, Loader2, MoreHorizontal, Plus, Queue, Sparkles, Trash2, UploadSimple } from './icons';
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
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { bySortOrder, useBishopStore } from '../store/useBishopStore';
import { MAX_CATEGORY_NAME_LENGTH, MAX_TAGLINE_LENGTH, SEVERITIES, severityOf, type Category, type Project, type ProjectCategory, type Task, type Topic } from '../types';
import { ACTIVE_LABEL, categoryDot, categoryLabel } from './categories';
import { ContextMenu, InlineInput, type MenuItem } from './ui';
import { BishopLogo } from './BishopLogo';
import { FolderBanner, FolderLine } from './ProjectFolder';
import { hasSession, TaskStatusBar, taskStatus } from './taskStatus';

// The overlay is a small chip, but dnd-kit places it at the dragged card's top-left. Move it so the
// pointer sits near the chip's left edge and vertical middle, wherever the card was grabbed.
const CHIP_POINTER_X = 20;
const CHIP_POINTER_Y = 14;
const keepChipUnderPointer: Modifier = ({ transform, activatorEvent, activeNodeRect }) => {
  if (!activeNodeRect || !activatorEvent) return transform;
  const e = activatorEvent as Partial<MouseEvent & TouchEvent>;
  const point = e.touches?.[0] ?? e;
  if (typeof point.clientX !== 'number' || typeof point.clientY !== 'number') return transform;
  return {
    ...transform,
    x: transform.x + (point.clientX - activeNodeRect.left) - CHIP_POINTER_X,
    y: transform.y + (point.clientY - activeNodeRect.top) - CHIP_POINTER_Y,
  };
};

type Columns = Record<Category, number[]>;

const NO_CATEGORIES: ProjectCategory[] = [];

/** The selected project's categories. Empty until they load. */
const useCategories = () => useBishopStore((s) => (s.selectedProjectId === null ? undefined : s.categories[s.selectedProjectId]) ?? NO_CATEGORIES);

export function CategorySelect({ value, onChange, className = '' }: { value: Category; onChange: (c: Category) => void; className?: string }) {
  const categories = useCategories();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Category)}
      // Keep keys in the dropdown from reaching the dialog underneath.
      onKeyDown={(e) => e.stopPropagation()}
      className={`rounded border border-[var(--border)] bg-[var(--sidebar)] text-xs px-1 py-0.5 outline-none focus:border-[var(--primary)] ${className}`}
    >
      {categories.map((c) => (
        <option key={c.key} value={c.key}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function TopicCardBody({ topic, showCategory = false }: { topic: Topic; showCategory?: boolean }) {
  const categories = useCategories();
  const done = topic.tasks.filter((t) => t.completed).length;
  const total = topic.tasks.length;
  return (
    <>
      {/* A fixed two-line slot, so titles take the same space on every card. Right padding keeps the title clear of the card's action buttons (refine, arrow). */}
      <div className="h-10 text-sm font-medium line-clamp-2 break-words pr-14" title={topic.title}>
        {topic.title}
      </div>
      {/* Always rendered, even when empty, so the bar sits at the same height on every card. */}
      <div className="mt-1 h-8 text-xs text-[var(--muted-foreground)] line-clamp-2 break-words">{topic.description}</div>
      {/* Right padding keeps the count clear of the card's archive button, which only shows on hover. */}
      <div className="mt-2 flex items-center gap-2 pr-6">
        <TaskStatusBar tasks={topic.tasks} dividers testId="topic-card-progress" className="h-1.5 flex-1 min-w-2 bg-[var(--sidebar)]" />
        {/* A fixed slot for the count, up to 99/99, so bars end at the same point on every card. */}
        <span className="shrink-0 min-w-[5ch] text-right text-sm font-semibold text-[var(--foreground)] tabular-nums">
          {done}/{total}
        </span>
      </div>
      {/* On its own line: next to the bar it would make the bar shorter on these cards. */}
      {showCategory && <div className="mt-1 pr-6 text-xs text-right">{categoryLabel(categories, topic.category)}</div>}
    </>
  );
}

const cardClass = 'rounded-md border border-[var(--border)] bg-[var(--card)] p-3';

/** `fixed` cards sit in the Active section: they don't drag. */
// Per-field selectors: a card re-renders only when something it shows changes, not on every store update.
const TopicCard = memo(function TopicCard({ topic, hint, fixed = false }: { topic: Topic; hint?: 'before' | 'after'; fixed?: boolean }) {
  const openTopic = useBishopStore((s) => s.openTopic);
  const setTopicArchived = useBishopStore((s) => s.setTopicArchived);
  const workOnTask = useBishopStore((s) => s.workOnTask);
  const setTaskQueued = useBishopStore((s) => s.setTaskQueued);
  const activeTaskIds = useBishopStore((s) => s.activeTaskIds);
  const setRefineTopicFor = useBishopStore((s) => s.setRefineTopicFor);
  const canWork = useBishopStore((s) => {
    const p = s.projects.find((q) => q.id === s.selectedProjectId);
    return !!p?.folderPath && !p.folderMissing;
  });
  const personal = useBishopStore((s) => s.projects.find((q) => q.id === s.selectedProjectId)?.displayType === 'personal');
  const pending = topic.id < 0;
  // Open tasks in checklist order. Unsaved tasks have no id for Claude to report back on.
  // Prerequisites are the user's own work, and agent tasks wait until all of them are done. Follow-ups don't block.
  const blocked = topic.tasks.some((t) => t.prerequisite && !t.followUp && !t.completed);
  // `!t.prerequisite` also drops follow-ups (they are user tasks), so start and queue never pick them.
  const openTasks = blocked ? [] : [...topic.tasks].sort(bySortOrder).filter((t) => !t.completed && t.id >= 0 && !t.prerequisite);
  // Claude is on a task in this project, so the arrow becomes Queue: it queues the next task still waiting for a turn.
  const busy = activeTaskIds.length > 0;
  // A task is being worked on or waiting its turn. Refine is turned off for these topics.
  const busyTopic = topic.tasks.some((t) => {
    const status = taskStatus(t, activeTaskIds);
    return status === 'active' || status === 'pending';
  });
  const nextTask = busy ? openTasks.find((t) => !t.queued && !activeTaskIds.includes(t.id)) : openTasks[0];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: topic.id, disabled: pending || fixed });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const done = topic.tasks.filter((t) => t.completed).length;

  // Personal projects: one compact line per topic. The title, the progress count and the same actions as the card.
  if (personal) {
    const iconBtn =
      'p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover/card:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:bg-[var(--sidebar)]';
    const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() };
    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        aria-disabled={pending}
        data-testid="topic-card"
        data-topic-id={topic.id}
        aria-label={fixed ? `${topic.title}. Press Enter to open.` : `${topic.title}. Press Space to pick up and move with arrow keys, Enter to open.`}
        className={`group/card relative flex items-center gap-2 h-9 px-3 rounded-md border border-[var(--border)] bg-[var(--card)] ${
          fixed ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
        } hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)] transition-colors ${pending ? 'opacity-60' : ''} ${
          isDragging ? 'opacity-30' : ''
        }`}
        onClick={() => !pending && openTopic(topic.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !pending) openTopic(topic.id);
          else listeners?.onKeyDown?.(e);
        }}
      >
        {hint && (
          <div
            data-testid="drop-hint"
            className={`absolute left-1 right-1 h-0.5 rounded bg-[var(--primary)] ${hint === 'before' ? '-top-1.5' : '-bottom-1.5'}`}
          />
        )}
        {/* A fixed 40% share of the row, so the titles line up in the same column on every row. */}
        <span className="w-2/5 min-w-0 shrink-0 truncate text-sm font-medium" title={topic.title}>
          {topic.title}
        </span>
        {/* A fixed quarter of the row for the progress bar and count, so they line up in the same column on every row. */}
        <div className="flex w-1/4 shrink-0 items-center gap-2">
          <TaskStatusBar tasks={topic.tasks} dividers testId="topic-card-progress" className="h-1.5 flex-1 min-w-2 bg-[var(--sidebar)]" />
          <span className="shrink-0 min-w-[5ch] text-right text-xs font-semibold tabular-nums">
            {done}/{topic.tasks.length}
          </span>
        </div>
        {/* A fixed-width area on the right, so the refine, start/queue and archive buttons line up in the same columns on every row. */}
        <div className="flex w-20 shrink-0 items-center justify-end gap-1">
          {!pending && !fixed && (
            <button
              data-testid="topic-card-refine"
              className={`${iconBtn} hover:text-[var(--primary-text)] aria-disabled:cursor-not-allowed aria-disabled:hover:!opacity-40`}
              title={busyTopic ? 'Refine is off while this topic has active or queued tasks' : 'Refine topic'}
              aria-label={`Refine ${topic.title}`}
              aria-disabled={busyTopic}
              {...stop}
              onClick={(e) => {
                e.stopPropagation();
                if (!busyTopic) setRefineTopicFor(topic.id);
              }}
            >
              <Sparkles size={14} />
            </button>
          )}
          {!pending && canWork && nextTask && (
            <button
              data-testid={busy ? 'topic-card-queue' : 'topic-card-work'}
              className={`${iconBtn} ${busy ? 'hover:text-[var(--task-pending)]' : 'hover:text-[var(--primary-text)]'}`}
              title={busy ? `Queue the next task: ${nextTask.title}` : 'Work on the next task (opens the Terminal)'}
              aria-label={busy ? `Queue ${nextTask.title}` : `Work on the next task in ${topic.title}`}
              {...stop}
              onClick={(e) => {
                e.stopPropagation();
                if (busy) setTaskQueued(nextTask.id, true);
                else workOnTask(nextTask.id);
              }}
            >
              {busy ? <Queue size={14} /> : <ArrowRight size={14} />}
            </button>
          )}
          {!pending && (
            <button
              data-testid="topic-card-archive"
              className={`${iconBtn} hover:text-[var(--foreground)]`}
              title="Archive topic"
              aria-label={`Archive ${topic.title}`}
              {...stop}
              onClick={(e) => {
                e.stopPropagation();
                setTopicArchived(topic.id, true);
              }}
            >
              <Archive size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // A fixed card can't drag but still opens, so it isn't disabled.
      aria-disabled={pending}
      data-testid="topic-card"
      data-topic-id={topic.id}
      aria-label={fixed ? `${topic.title}. Press Enter to open.` : `${topic.title}. Press Space to pick up and move with arrow keys, Enter to open.`}
      className={`${cardClass} group/card relative ${fixed ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)] transition-colors ${
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
      <TopicCardBody topic={topic} />
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        {!pending && !fixed && (
          <button
            data-testid="topic-card-refine"
            className="p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover/card:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--primary-text)] hover:bg-[var(--sidebar)] aria-disabled:cursor-not-allowed aria-disabled:hover:!opacity-40"
            title={busyTopic ? 'Refine is off while this topic has active or queued tasks' : 'Refine topic'}
            aria-label={`Refine ${topic.title}`}
            aria-disabled={busyTopic}
            // The card handles these too: keep the button from opening the topic or starting a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!busyTopic) setRefineTopicFor(topic.id);
            }}
          >
            <Sparkles size={14} />
          </button>
        )}
        {!pending && canWork && nextTask && (
          <button
            data-testid={busy ? 'topic-card-queue' : 'topic-card-work'}
            className={`p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover/card:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:bg-[var(--sidebar)] ${
              busy ? 'hover:text-[var(--task-pending)]' : 'hover:text-[var(--primary-text)]'
            }`}
            title={busy ? `Queue the next task: ${nextTask.title}` : 'Work on the next task (opens the Terminal)'}
            aria-label={busy ? `Queue ${nextTask.title}` : `Work on the next task in ${topic.title}`}
            // The card handles these too: keep the button from opening the topic or starting a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (busy) setTaskQueued(nextTask.id, true);
              else workOnTask(nextTask.id);
            }}
          >
            {busy ? <Queue size={14} /> : <ArrowRight size={14} />}
          </button>
        )}
      </div>
      {!pending && (
        <button
          data-testid="topic-card-archive"
          className="absolute bottom-2 right-2 p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover/card:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--foreground)] hover:bg-[var(--sidebar)]"
          title="Archive topic"
          aria-label={`Archive ${topic.title}`}
          // The card handles these too: keep the button from opening the topic or starting a drag.
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setTopicArchived(topic.id, true);
          }}
        >
          <Archive size={14} />
        </button>
      )}
    </div>
  );
});

/** Keyed by category. */
type CollapsedMap = Record<string, boolean>;

const collapsedKey = (projectId: number) => `bishop_collapsed_${projectId}`;

function readCollapsed(projectId: number): CollapsedMap {
  try {
    const raw = localStorage.getItem(collapsedKey(projectId));
    return raw ? (JSON.parse(raw) as CollapsedMap) : {};
  } catch {
    return {};
  }
}

/** Room for the context menu (min-w-44) plus a small margin. */
const MENU_WIDTH = 184;

/** Says what moves with a removed category. Archived topics are named, since the board doesn't show them. */
function movingTopics(active: number, archived: number): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (active > 0 && archived > 0) return `Its ${count(active, 'topic')} and ${count(archived, 'archived topic')} move`;
  if (archived > 0) return archived === 1 ? 'Its archived topic moves' : `Its ${archived} archived topics move`;
  return active === 1 ? 'Its topic moves' : `Its ${active} topics move`;
}

/** One category, stacked: a header row, then its cards in a wrapping grid. */
function Section({
  projectId,
  category,
  topics,
  collapsed,
  onToggle,
  hint,
}: {
  projectId: number;
  category: Category;
  topics: Topic[];
  collapsed: boolean;
  onToggle: () => void;
  hint: DropHint | null;
}) {
  const createTopic = useBishopStore((s) => s.createTopic);
  const renameCategory = useBishopStore((s) => s.renameCategory);
  const removeCategory = useBishopStore((s) => s.removeCategory);
  const confirm = useBishopStore((s) => s.confirm);
  const categories = useCategories();
  const label = categoryLabel(categories, category);
  // Counts archived topics and those showing in Active too: they all move when the category goes.
  const topicCount = useBishopStore((s) => s.topics.filter((t) => t.category === category).length);
  const archivedCount = useBishopStore((s) => s.topics.filter((t) => t.category === category && t.archivedAt).length);
  const personal = useBishopStore((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.displayType === 'personal');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Expanded: the grid is the drop target. Collapsed: the header is (dropping appends).
  const { setNodeRef, isOver } = useDroppable({ id: category });

  const remove = async (moveTo: ProjectCategory | null) => {
    const topicsMove = moveTo ? ` ${movingTopics(topicCount - archivedCount, archivedCount)} to "${moveTo.name}".` : '';
    if (await confirm({ title: 'Remove category?', message: `"${label}" will be removed.${topicsMove}`, confirmLabel: 'Remove' }))
      removeCategory(projectId, category, moveTo?.key ?? null);
  };
  const others = categories.filter((c) => c.key !== category);
  // Only topics on the board make the user choose. Archived ones still need a category, so they go to the first one left.
  const removeItem: MenuItem =
    topicCount > archivedCount && others.length > 0
      ? { label: 'Remove, move topics to', danger: true, children: others.map((c) => ({ label: c.name, onSelect: () => remove(c) })) }
      : { label: 'Remove', danger: true, disabled: others.length === 0, onSelect: () => remove(archivedCount > 0 ? others[0] : null) };

  return (
    <section data-testid={`column-${category}`} aria-label={label} className="flex flex-col gap-2">
      <header
        ref={collapsed ? setNodeRef : undefined}
        onContextMenu={(e) => {
          if (renaming) return; // Leave the input its own menu, for paste.
          e.preventDefault();
          // Keep the menu on screen when the header is right-clicked near the window's edge.
          setMenu({ x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH), y: e.clientY });
        }}
        className={`group/header flex items-center gap-2 py-1.5 border-b transition-colors ${
          collapsed && isOver ? 'border-[var(--primary)] bg-[var(--primary-subtle)]' : 'border-[var(--border)]'
        }`}
      >
        {renaming ? (
          <div className="flex items-center gap-2 w-72 max-w-full">
            <span className={`shrink-0 w-3 h-3 rounded-full ${categoryDot(category)}`} />
            <InlineInput
              initial={label}
              maxLength={MAX_CATEGORY_NAME_LENGTH}
              className="!py-0 !text-sm"
              onCommit={(name) => {
                setRenaming(false);
                renameCategory(projectId, category, name);
              }}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <>
            <button
              className="flex items-center gap-2 rounded px-1 -ml-1 py-0.5 hover:text-[var(--foreground)] text-[var(--muted-foreground)]"
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand' : 'Collapse'}
              onClick={onToggle}
            >
              <ChevronRight size={14} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
              <span className={`shrink-0 w-3 h-3 rounded-full ${categoryDot(category)}`} />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{label}</h2>
              <span className="text-xs tabular-nums">{topics.length}</span>
            </button>
            <button
              data-testid={`category-actions-${category}`}
              className="p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover/header:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:bg-[var(--card)]"
              title="Category actions"
              aria-label={`Actions for ${label}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 2 });
              }}
            >
              <MoreHorizontal size={16} />
            </button>
          </>
        )}
      </header>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={[{ label: 'Rename', onSelect: () => setRenaming(true) }, removeItem]} onClose={closeMenu} />}
      {!collapsed && (
        <div
          ref={setNodeRef}
          className={`grid gap-2 ${personal ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]'} rounded-md transition-colors ${
            isOver ? 'bg-[var(--primary-subtle)]' : ''
          }`}
        >
          <SortableContext items={topics.map((t) => t.id)} strategy={personal ? verticalListSortingStrategy : rectSortingStrategy}>
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
              title="Add topic"
              aria-label="Add topic"
              className={`flex items-center justify-center ${personal ? 'h-9' : 'min-h-[130px] p-3'} rounded-md border-2 border-dashed border-transparent text-[var(--muted-foreground)] hover:border-[var(--primary)] hover:text-[var(--foreground)] transition-colors`}
              onClick={() => setAdding(true)}
            >
              <Plus size={personal ? 18 : 32} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The first section of the board. It is not a stored category: a topic keeps its own category and
 * only shows here while it has a session, so there is nothing to rename, add to or drop on.
 * Its cards don't drag either: a drop could not take a topic out of here while its session lasts.
 * It has a plain, larger title and does not collapse, which sets it apart from the categories below.
 */
/**
 * Where a topic sits in the Active section: topics with a running task first, then queued topics by the
 * time their earliest queued task was queued. Array.sort is stable, so ties keep the overview order.
 */
function queueRank(topic: Topic, activeTaskIds: number[]): number {
  if (topic.tasks.some((t) => activeTaskIds.includes(t.id))) return -1;
  let first = Infinity;
  for (const t of topic.tasks) {
    if (!t.queued || t.completed) continue;
    first = Math.min(first, t.queuedAt ? Date.parse(t.queuedAt) || 0 : 0);
  }
  return first;
}

function ActiveSection({ topics }: { topics: Topic[] }) {
  const personal = useBishopStore((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.displayType === 'personal');
  return (
    <section data-testid="active-section" aria-label={ACTIVE_LABEL} className="flex flex-col gap-2">
      <header className="py-1.5">
        <h2 className="text-lg font-semibold uppercase tracking-wider text-[var(--foreground)]">{ACTIVE_LABEL}</h2>
      </header>
      {topics.length > 0 ? (
        <div className={`grid gap-2 ${personal ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]'}`}>
          {topics.map((t) => (
            <TopicCard key={t.id} topic={t} fixed />
          ))}
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-[var(--muted-foreground)]">Topics with active or queued sessions show here.</p>
      )}
    </section>
  );
}

/** Where a card dragged in from another section will land: next to a card, or at the end. */
type DropHint = { category: Category; cardId: number | null; after: boolean };

function buildColumns(categories: ProjectCategory[], topics: Topic[]): Columns {
  const cols: Columns = Object.fromEntries(categories.map((c) => [c.key, []]));
  // The topics can arrive before the categories do.
  for (const t of [...topics].sort(bySortOrder)) cols[t.category]?.push(t.id);
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
  const moveTopicToProject = useBishopStore((s) => s.moveTopicToProject);
  const setTopicDropProject = useBishopStore((s) => s.setTopicDropProject);
  const activeTaskIds = useBishopStore((s) => s.activeTaskIds);
  // Every topic, including those showing in Active: moveTopic's index counts the whole category.
  const categories = useCategories();
  const keys = useMemo(() => categories.map((c) => c.key), [categories]);
  const columns = useMemo(() => buildColumns(categories, topics), [categories, topics]);
  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const inSession = useMemo(() => new Set(topics.filter((t) => hasSession(t, activeTaskIds)).map((t) => t.id)), [topics, activeTaskIds]);
  const [activeId, setActiveId] = useState<number | null>(null);
  // The dragged topic is over the sidebar's projects panel (the next task shrinks the overlay while true).
  const [overProjectsPanel, setOverProjectsPanel] = useState(false);
  const [hint, setHint] = useState<DropHint | null>(null);
  const startColumn = useRef<Category | undefined>(undefined);

  // Collapsed sections, remembered per project (best effort; storage may be unavailable).
  const [collapsed, setCollapsed] = useState<CollapsedMap>(() => readCollapsed(projectId));
  useEffect(() => setCollapsed(readCollapsed(projectId)), [projectId]);
  const toggle = (c: string) =>
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

  const isColumn = (id: UniqueIdentifier) => id in columns;
  const containerOf = (id: UniqueIdentifier): Category | undefined =>
    isColumn(id) ? (id as Category) : keys.find((c) => columns[c].includes(Number(id)));

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

  /**
   * The sidebar project under the pointer, if any: dropping a topic there moves it to that project.
   * The sidebar has its own drag context, so rows are found by their `data-project-id` instead.
   * Looks through the drag overlay (it sits under the pointer). The open project is no target. Null for keyboard drags.
   */
  const projectUnder = (e: DragMoveEvent | DragEndEvent): number | null => {
    const p = pointerAt(e);
    if (!p) return null;
    for (const el of document.elementsFromPoint(p.x, p.y)) {
      const id = Number(el.closest('[data-project-id]')?.getAttribute('data-project-id'));
      if (id) return id === projectId ? null : id;
    }
    return null;
  };

  const isPersonal = useBishopStore((s) => s.projects.find((p) => p.id === projectId)?.displayType === 'personal');
  const computeHint = (e: DragMoveEvent | DragEndEvent): DropHint | null => {
    const { active, over } = e;
    if (!over || projectUnder(e) !== null) return null;
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
    // Personal rows span the full width and stack, so only the vertical position counts.
    const after = sameRow && !isPersonal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    return { category: target, cardId: Number(over.id), after };
  };

  /** True when the pointer is over the sidebar's projects panel (`data-projects-panel`). Null-pointer (keyboard) drags: false. */
  const overPanel = (e: DragMoveEvent | DragEndEvent): boolean => {
    const p = pointerAt(e);
    if (!p) return false;
    return document.elementsFromPoint(p.x, p.y).some((el) => el.hasAttribute('data-projects-panel'));
  };

  const reset = () => {
    setOverProjectsPanel(false);
    setActiveId(null);
    setHint(null);
    setTopicDropProject(null);
    startColumn.current = undefined;
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(Number(active.id));
    startColumn.current = containerOf(active.id);
  };

  const onDragMove = (e: DragMoveEvent) => {
    setTopicDropProject(projectUnder(e));
    setOverProjectsPanel(overPanel(e));
    const next = computeHint(e);
    setHint((prev) =>
      prev?.category === next?.category && prev?.cardId === next?.cardId && prev?.after === next?.after ? prev : next,
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const id = Number(active.id);
    const from = startColumn.current;
    const toProject = projectUnder(e);
    const dropHint = computeHint(e);
    reset();
    if (toProject !== null) {
      // Dropped on a project in the sidebar: the topic moves there.
      moveTopicToProject(id, toProject);
      return;
    }
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
        <ActiveSection
          topics={keys.flatMap((c) => columns[c])
            .filter((id) => inSession.has(id))
            .map((id) => byId.get(id)!)
            .map((t) => ({ t, rank: queueRank(t, activeTaskIds) }))
            .sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1))
            .map((x) => x.t)}
        />
        {keys.map((cat) => (
          <Section
            key={cat}
            projectId={projectId}
            category={cat}
            topics={columns[cat].filter((id) => !inSession.has(id)).map((id) => byId.get(id)!).filter(Boolean)}
            collapsed={!!collapsed[cat]}
            onToggle={() => toggle(cat)}
            hint={hint?.category === cat ? hint : null}
          />
        ))}
      </div>
      <DragOverlay modifiers={[keepChipUnderPointer]}>
        {active && (
          <div
            data-over-projects-panel={overProjectsPanel ? '' : undefined}
            className="w-40 truncate rounded-md border border-[var(--primary)] bg-[var(--card)] px-2 py-1 text-xs shadow-xl rotate-1 cursor-grabbing"
          >
            {active.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** Archived topics, newest first, under the board. Collapsed until asked for; cards don't drag. */
function ArchivedSection({ topics }: { topics: Topic[] }) {
  const { openTopic, setTopicArchived } = useBishopStore();
  const [open, setOpen] = useState(false);
  if (topics.length === 0) return null;
  const newestFirst = [...topics].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  return (
    <section data-testid="archived-section" aria-label="Archived" className="flex flex-col gap-2 pb-6">
      <header className="flex items-center gap-2 py-1.5 border-b border-[var(--border)]">
        <button
          className="flex items-center gap-2 rounded px-1 -ml-1 hover:text-[var(--foreground)] text-[var(--muted-foreground)]"
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          <h2 className="text-xs font-semibold uppercase tracking-wider">Archived</h2>
          <span className="text-xs tabular-nums">{topics.length}</span>
        </button>
      </header>
      {open && (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
          {newestFirst.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              data-testid="archived-topic"
              data-topic-id={t.id}
              className={`${cardClass} cursor-pointer hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)] transition-colors`}
              onClick={() => openTopic(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) openTopic(t.id);
              }}
            >
              <TopicCardBody topic={t} showCategory />
              <div className="mt-2 flex justify-end">
                <button
                  className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--sidebar)]"
                  aria-label={`Restore ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTopicArchived(t.id, false);
                  }}
                >
                  <ArrowUUpLeft size={13} /> Restore
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
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

/** Top-of-page panel: title, tagline and folder on the left, the project picture on the right. */
function OverviewPanel({ project }: { project: Project }) {
  const setProjectImage = useBishopStore((s) => s.setProjectImage);
  const [dragOver, setDragOver] = useState(false);
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
      // wrap-reverse swaps the cross axis, so items-end keeps the title at the top of the panel.
      className="group/overview -mx-5 -mt-5 px-6 pt-6 pb-2 flex flex-wrap-reverse items-end gap-6"
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
          <h1 className="text-4xl font-semibold truncate max-w-full">{project.name}</h1>
          <ProjectTagline project={project} />
        </div>

        <FolderLine project={project} />
      </div>
      <ProjectPicture project={project} onFile={onFile} dragOver={dragOver} />
    </section>
  );
}

/**
 * One task in a personal project: complete check box on the left, a text field, a severity drop down and a
 * remove button on the right. The text saves on Enter or when the field loses focus; Esc puts the old text back.
 */
function PersonalTaskRow({ task }: { task: Task }) {
  const { setTaskCompleted, setTaskComplexity, renameTask, deleteTask } = useBishopStore();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: task.id < 0 });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const [text, setText] = useState(task.title);
  useEffect(() => setText(task.title), [task.title]);
  const pending = task.id < 0;
  const severity = severityOf(task.complexity);
  const save = () => {
    const next = text.trim();
    if (!next) setText(task.title);
    else if (next !== task.title) renameTask(task.id, next);
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid="personal-task"
      data-task-id={task.id}
      data-severity={severity}
      className={`group flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--card)] ${pending ? 'opacity-60' : ''} ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        data-testid="personal-task-grip"
        title="Drag to reorder or move to another category (or focus and press Space, then arrow keys)"
        aria-label={`Move ${task.title}`}
        className="shrink-0 -ml-1 px-0.5 h-5 flex items-center rounded cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 focus-visible:opacity-100"
      >
        <GripVertical size={14} />
      </button>
      <input
        type="checkbox"
        data-testid="personal-task-complete"
        className="shrink-0"
        checked={task.completed}
        disabled={pending}
        aria-label={`Complete ${task.title}`}
        onChange={(e) => setTaskCompleted(task.id, e.target.checked)}
      />
      <input
        type="text"
        data-testid="personal-task-text"
        value={text}
        disabled={pending}
        aria-label="Task"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setText(task.title);
            e.currentTarget.blur();
          }
        }}
        className={`flex-1 min-w-0 text-sm bg-transparent rounded px-1 py-0.5 border border-transparent hover:border-[var(--border)] focus:border-[var(--primary)] focus:outline-none ${
          task.completed ? 'line-through text-[var(--muted-foreground)]' : ''
        }`}
      />
      <select
        data-testid="personal-task-severity"
        value={severity}
        disabled={pending}
        aria-label={`Severity of ${task.title}`}
        title="Severity"
        onChange={(e) => setTaskComplexity(task.id, SEVERITIES.find((s) => s.key === e.target.value)!.complexity)}
        className="shrink-0 text-xs rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] px-1.5 py-0.5 focus:border-[var(--primary)] focus:outline-none"
      >
        {SEVERITIES.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <button
        data-testid="personal-task-remove"
        title="Remove task"
        aria-label={`Remove ${task.title}`}
        disabled={pending}
        onClick={() => deleteTask(task.id)}
        className="shrink-0 h-6 w-6 grid place-items-center rounded text-[var(--muted-foreground)] opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

/**
 * Personal projects: only categories and their tasks. A category's tasks are those of its topics on the
 * board, in topic then checklist order.
 */
function PersonalColumn({
  category,
  tasks,
  collapsed,
  onToggle,
}: {
  category: ProjectCategory;
  tasks: Task[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const addCategoryTask = useBishopStore((s) => s.addCategoryTask);
  const [adding, setAdding] = useState(false);
  // The whole section takes drops, so a task can land on a collapsed or empty category too.
  const { setNodeRef, isOver } = useDroppable({ id: `${CATEGORY_DROP}${category.key}` });

  return (
    <section
      ref={setNodeRef}
      data-testid={`personal-column-${category.key}`}
      aria-label={category.name}
      className={`flex flex-col gap-1 rounded transition-colors ${isOver ? 'bg-[var(--card)]' : ''}`}
    >
      <header className="flex items-center gap-2 py-1.5 border-b border-[var(--border)]">
        <button
          className="flex items-center gap-2 rounded px-1 -ml-1 py-0.5 hover:text-[var(--foreground)] text-[var(--muted-foreground)]"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={onToggle}
        >
          <ChevronRight size={14} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <span className={`shrink-0 w-3 h-3 rounded-full ${categoryDot(category.key)}`} />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{category.name}</h2>
          <span className="text-xs tabular-nums">{tasks.filter((t) => !t.completed).length}</span>
        </button>
      </header>
      {!collapsed && (
        <ul className="flex flex-col">
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <PersonalTaskRow key={task.id} task={task} />
            ))}
          </SortableContext>
          <li className="px-2 py-1">
            {adding ? (
              <InlineInput
                placeholder="Task"
                onCommit={(title) => {
                  setAdding(false);
                  addCategoryTask(category.key, category.name, title);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                onClick={() => setAdding(true)}
              >
                <Plus size={13} /> Add task
              </button>
            )}
          </li>
        </ul>
      )}
    </section>
  );
}

/** Ids of the category drop targets, so they can't clash with task ids (numbers). */
const CATEGORY_DROP = 'category:';

/** Prefers the task under the pointer over the category around it, so a drop between tasks still orders them. */
const personalCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const fallback = hits.length > 0 ? hits : closestCenter(args);
  const tasks = fallback.filter((h) => !String(h.id).startsWith(CATEGORY_DROP));
  return tasks.length > 0 ? tasks : fallback;
};

function PersonalBoard({ topics, projectId }: { topics: Topic[]; projectId: number }) {
  const categories = useCategories();
  const reorderTasks = useBishopStore((s) => s.reorderTasks);
  const moveTaskToCategory = useBishopStore((s) => s.moveTaskToCategory);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [collapsed, setCollapsed] = useState<CollapsedMap>(() => readCollapsed(projectId));
  useEffect(() => setCollapsed(readCollapsed(projectId)), [projectId]);
  const toggle = (c: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [c]: !prev[c] };
      try {
        localStorage.setItem(collapsedKey(projectId), JSON.stringify(next));
      } catch {}
      return next;
    });

  // A category's tasks are those of its topics on the board, in topic then checklist order.
  const tasksOf = (key: Category) =>
    topics
      .filter((t) => t.category === key)
      .sort(bySortOrder)
      .flatMap((t) => [...t.tasks].sort(bySortOrder));

  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const activeTask = activeTaskId === null ? undefined : topics.flatMap((t) => t.tasks).find((t) => t.id === activeTaskId);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const all = categories.flatMap((c) => tasksOf(c.key).map((t) => ({ task: t, category: c })));
    const from = all.find((x) => x.task.id === active.id);
    if (!from) return;
    const overId = String(over.id);
    const toTask = all.find((x) => x.task.id === over.id);
    const toCategory = toTask ? toTask.category : categories.find((c) => overId === `${CATEGORY_DROP}${c.key}`);
    if (!toCategory) return;

    if (toCategory.key === from.category.key) {
      // Reordering works within one topic's tasks, since the host orders tasks per topic. A category normally has one topic.
      if (!toTask || from.task.topicId !== toTask.task.topicId) return;
      const group = tasksOf(toCategory.key).filter((t) => t.topicId === from.task.topicId);
      const moved = arrayMove(group, group.indexOf(from.task), group.indexOf(toTask.task));
      reorderTasks(from.task.topicId, moved.map((t) => t.id));
      return;
    }

    // Another category: land at the hovered task's place when it is in the category's first topic, else at the end.
    const targetTopic = topics
      .filter((t) => t.category === toCategory.key && t.id >= 0)
      .sort(bySortOrder)[0];
    const inTarget = targetTopic ? [...targetTopic.tasks].sort(bySortOrder) : [];
    const index = toTask && targetTopic && toTask.task.topicId === targetTopic.id ? inTarget.findIndex((t) => t.id === toTask.task.id) : null;
    moveTaskToCategory(from.task.id, toCategory.key, toCategory.name, index === null || index < 0 ? null : index);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={personalCollision}
      onDragStart={({ active }) => setActiveTaskId(Number(active.id))}
      onDragEnd={(e) => {
        setActiveTaskId(null);
        onDragEnd(e);
      }}
      onDragCancel={() => setActiveTaskId(null)}
    >
      <div data-testid="personal-board" className="flex flex-col gap-5 pb-6">
        {categories.map((c) => (
          <PersonalColumn key={c.key} category={c} tasks={tasksOf(c.key)} collapsed={!!collapsed[c.key]} onToggle={() => toggle(c.key)} />
        ))}
      </div>
      {/* The overlay is placed from the pointer, so the preview stays under the mouse even across categories and while scrolling. */}
      <DragOverlay>
        {activeTask && (
          <div className="flex items-center gap-2 px-2 py-1 rounded border border-[var(--primary)] bg-[var(--card)] shadow-xl cursor-grabbing">
            <GripVertical size={14} className="shrink-0 opacity-70" />
            <span className={`flex-1 min-w-0 truncate text-sm px-1 ${activeTask.completed ? 'line-through text-[var(--muted-foreground)]' : ''}`}>{activeTask.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export function ProjectOverview() {
  const project = useBishopStore((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const topics = useBishopStore((s) => s.topics);
  const [boardTopics, archivedTopics] = useMemo(() => [topics.filter((t) => !t.archivedAt), topics.filter((t) => t.archivedAt)], [topics]);

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
      <OverviewPanel project={project} />
      {(!project.folderPath || project.folderMissing) && <FolderBanner project={project} />}
      <Board topics={boardTopics} projectId={project.id} />
      <ArchivedSection key={project.id} topics={archivedTopics} />
    </div>
  );
}
