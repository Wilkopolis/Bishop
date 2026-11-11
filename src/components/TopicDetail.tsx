import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Archive, ArrowRight, ArrowUUpLeft, CaretDown, Check, GripVertical, Queue, Trash2, X } from './icons';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api/client';
import { bySortOrder, useBishopStore } from '../store/useBishopStore';
import { DEFAULT_MODEL, effortLabel, MODEL_FAMILIES, type AiService, type ModelFamily, type Task, type Topic, type TopicContextFile } from '../types';
import { ContextMenu, InlineInput, Modal, type MenuItem } from './ui';
import { TaskComplexityDot, taskStatus, TASK_STATUS_LABELS, type TaskStatus } from './taskStatus';

const CHECKBOX_CLASSES: Record<TaskStatus, string> = {
  complete: 'bg-[var(--task-complete)] border-[var(--task-complete)] text-[var(--task-complete-foreground)]',
  active: 'border-[var(--task-active)] bg-[var(--task-active)]',
  pending: 'border-[var(--task-pending)]',
  unassigned: 'border-[var(--task-unassigned)] hover:border-[var(--task-complete)]',
};

/** `blocked`: the topic has open prerequisites, so this agent task can't be queued or started yet. */
function TaskRow({ task, onWork, blocked = false }: { task: Task; onWork?: () => void; blocked?: boolean }) {
  const { setTaskCompleted, setTaskQueued, setTaskPrerequisite, setTaskFollowUp, setTaskReply, renameTask, deleteTask, activeTaskIds, openComplexityPicker } = useBishopStore();
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState(task.reply ?? '');
  const canReply = task.prerequisite && !task.completed && task.id >= 0;
  const replySave = useRef<Promise<void>>(Promise.resolve());
  const saveReply = () => {
    if (replyDraft !== (task.reply ?? '')) replySave.current = setTaskReply(task.id, replyDraft);
  };
  // Clicking the checkbox blurs the reply box first. Wait for that save so the reply is in before the task completes.
  const toggleCompleted = async () => {
    await replySave.current;
    setReplyOpen(false);
    setTaskCompleted(task.id, !task.completed);
  };
  // Claude is on a task in this project, so the arrow gives way to Queue. The active task itself has neither.
  const busy = activeTaskIds.length > 0;
  const active = activeTaskIds.includes(task.id);
  const status = taskStatus(task, activeTaskIds);
  const [editing, setEditing] = useState(false);
  const pending = task.id < 0;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: pending });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid="task-row"
      data-task-id={task.id}
      data-complexity={task.complexity}
      className={`group flex flex-wrap items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--card)] ${pending ? 'opacity-60' : ''} ${
        isDragging ? 'relative z-10 bg-[var(--card)] shadow-lg' : ''
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        title="Drag to reorder (or focus and press Space, then arrow keys)"
        aria-label={`Reorder ${task.title}`}
        className="shrink-0 -ml-1 px-0.5 h-5 flex items-center rounded cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 focus-visible:opacity-100"
      >
        <GripVertical size={14} />
      </button>
      <button
        title={task.completed ? 'Mark open' : `${TASK_STATUS_LABELS[status]}. Click to complete`}
        data-status={status}
        disabled={pending}
        onClick={toggleCompleted}
        className={`shrink-0 w-4 h-4 rounded border grid place-items-center mt-0.5 ${CHECKBOX_CLASSES[status]}`}
      >
        {task.completed && <Check size={12} />}
      </button>
      {/* A pending task has no id yet, so there is nothing to change. */}
      <TaskComplexityDot
        complexity={task.complexity}
        completed={task.completed}
        className="mt-[5px]"
        onClick={pending ? undefined : () => openComplexityPicker(task.id)}
      />
      {editing ? (
        <InlineInput className="flex-1 min-w-0" initial={task.title} onCommit={(t) => { setEditing(false); renameTask(task.id, t); }} onCancel={() => setEditing(false)} />
      ) : (
        <span
          className={`flex-1 min-w-0 text-sm break-words select-text ${task.completed ? 'line-through text-[var(--muted-foreground)]' : ''}`}
          onDoubleClick={() => !pending && setEditing(true)}
        >
          {task.title}
        </span>
      )}
      {/* Follow-ups never get queue or start buttons: they are done by hand, after the tasks. */}
      {!task.completed && !pending && !active && !task.prerequisite && !task.followUp && !blocked && (
        <button
          title={task.queued ? 'Remove from queue' : 'Queue this task'}
          aria-label={task.queued ? `Remove ${task.title} from queue` : `Queue ${task.title}`}
          aria-pressed={task.queued}
          data-testid="task-queue"
          onClick={() => setTaskQueued(task.id, !task.queued)}
          className={`shrink-0 h-5 flex items-center p-0.5 rounded focus-visible:opacity-100 ${
            task.queued ? 'text-[var(--task-pending)]' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-[var(--task-pending)]'
          }`}
        >
          <Queue size={14} />
        </button>
      )}
      {blocked && !task.completed && !task.prerequisite && (
        <span data-testid="task-blocked" title="Finish the prerequisites above to start this task" className="shrink-0 h-5 flex items-center text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
          Waiting
        </span>
      )}
      {onWork && !task.completed && !pending && !busy && !task.prerequisite && !task.followUp && !blocked && (
        <button
          title="Work on this task (opens the Terminal)"
          aria-label={`Work on ${task.title}`}
          onClick={onWork}
          className="shrink-0 h-5 flex items-center p-0.5 rounded opacity-0 group-hover:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--primary-text)]"
        >
          <ArrowRight size={14} />
        </button>
      )}
      {canReply && (
        <button
          title={task.reply ? 'Edit your reply' : 'Type a reply to this task'}
          aria-label={`Reply to ${task.title}`}
          aria-expanded={replyOpen}
          data-testid="task-reply"
          onClick={() => {
            if (replyOpen) saveReply();
            else setReplyDraft(task.reply ?? '');
            setReplyOpen(!replyOpen);
          }}
          className={`shrink-0 h-5 flex items-center px-1 rounded text-[10px] uppercase tracking-wider focus-visible:opacity-100 ${
            task.reply ? 'text-[var(--primary-text)]' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-[var(--primary-text)]'
          }`}
        >
          Reply
        </button>
      )}
      {!task.completed && !pending && (
        <button
          title={task.prerequisite ? 'Make this an agent task' : 'Mark as a prerequisite: work you must do yourself'}
          aria-label={task.prerequisite ? `Make ${task.title} an agent task` : `Mark ${task.title} as a prerequisite`}
          aria-pressed={task.prerequisite}
          data-testid="task-prerequisite"
          onClick={() => setTaskPrerequisite(task.id, !task.prerequisite)}
          className="shrink-0 h-5 flex items-center px-1 rounded text-[10px] uppercase tracking-wider opacity-0 group-hover:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--primary-text)]"
        >
          {task.prerequisite ? 'Agent' : 'Mine'}
        </button>
      )}
      {task.prerequisite && !task.completed && !pending && (
        <button
          title={task.followUp ? 'Make this a prerequisite: do it before the tasks below' : 'Make this a follow-up: do it after the tasks'}
          aria-label={task.followUp ? `Make ${task.title} a prerequisite` : `Make ${task.title} a follow-up`}
          aria-pressed={task.followUp}
          data-testid="task-follow-up"
          onClick={() => setTaskFollowUp(task.id, !task.followUp)}
          className={`shrink-0 h-5 flex items-center px-1 rounded text-[10px] uppercase tracking-wider focus-visible:opacity-100 ${
            task.followUp ? 'text-[var(--primary-text)]' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-[var(--primary-text)]'
          }`}
        >
          {task.followUp ? 'Follow-up' : 'Prereq'}
        </button>
      )}
      <button
        title="Remove task"
        disabled={pending}
        onClick={() => deleteTask(task.id)}
        className="shrink-0 h-5 flex items-center p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-red-400"
      >
        <X size={14} />
      </button>
      {canReply && replyOpen && (
        <textarea
          data-testid="task-reply-input"
          aria-label={`Reply to ${task.title}`}
          value={replyDraft}
          autoFocus
          rows={3}
          maxLength={20000}
          placeholder="Type your answer to this task"
          onChange={(e) => setReplyDraft(e.target.value)}
          onBlur={saveReply}
          className="basis-full ml-10 mr-6 px-2 py-1 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] resize-y focus:outline-none focus:border-[var(--primary)]"
        />
      )}
      {task.prerequisite && task.completed && task.reply && (
        <p data-testid="task-answer" className="basis-full min-w-0 ml-10 mr-6 pl-2 text-sm whitespace-pre-wrap break-words select-text border-l-2 border-[var(--border)] text-[var(--muted-foreground)]">
          {task.reply}
        </p>
      )}
    </li>
  );
}

const SESSION_MODES = [
  { sameSession: false, label: 'New session', title: 'Each task starts in a new Claude session' },
  { sameSession: true, label: 'Same session', title: 'Each task continues in the previous Claude session' },
];

function SessionSwitch({ sameSession, disabled, onChange }: { sameSession: boolean; disabled: boolean; onChange: (sameSession: boolean) => void }) {
  return (
    <div role="group" aria-label="Session for each task" data-testid="topic-session-switch" className="flex rounded border border-[var(--border)] overflow-hidden text-xs">
      {SESSION_MODES.map((mode) => {
        const selected = mode.sameSession === sameSession;
        return (
          <button
            key={mode.label}
            title={mode.title}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => !selected && onChange(mode.sameSession)}
            className={`px-2 py-0.5 ${
              selected ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]'
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

function ModelFamilySwitch({ value, disabled, onChange }: { value: ModelFamily; disabled: boolean; onChange: (family: ModelFamily) => void }) {
  return (
    <div role="group" aria-label="Model family" data-testid="topic-model-family-switch" className="flex rounded border border-[var(--border)] overflow-hidden text-xs">
      {MODEL_FAMILIES.map((family) => {
        const selected = family.value === value;
        return (
          <button
            key={family.value}
            title={family.title}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => !selected && onChange(family.value)}
            className={`px-2 py-0.5 ${
              selected ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]'
            }`}
          >
            {family.label}
          </button>
        );
      })}
    </div>
  );
}

/** Picks one model and reasoning level for the topic's tasks. "Automatic" clears it, so tasks are delegated by intensity. */
function ModelOverrideMenu({ topic, disabled }: { topic: Topic; disabled: boolean }) {
  const { updateTopic, aiModelLists, loadAiModels } = useBishopStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const service: AiService = topic.modelFamily === 'gemini' ? 'antigravity' : 'claude';
  useEffect(() => {
    loadAiModels(service);
  }, [service, loadAiModels]);
  const models = aiModelLists[service];
  const { modelOverride: model, effortOverride: effort } = topic;
  const set = (id: string | null, level: string | null) => updateTopic(topic.id, { modelOverride: id, effortOverride: level });
  const item = (id: string | null, level: string | null, label: string): MenuItem => ({
    label,
    checked: id === model && level === effort,
    onSelect: () => set(id, level),
  });
  const items: MenuItem[] = [
    item(null, null, 'Automatic'),
    ...(models ?? []).flatMap((m) => (m.efforts.length ? m.efforts.map((l) => item(m.id, l, `${m.label} · ${effortLabel(l)}`)) : [item(m.id, null, m.label)])),
    ...(models?.length ? [] : [{ label: models ? "Couldn't list the models" : 'Loading models…', disabled: true }]),
  ];
  const text = model || effort ? `${model ? (models?.find((m) => m.id === model)?.label ?? model) : DEFAULT_MODEL}${effort ? ` · ${effortLabel(effort)}` : ''}` : 'Automatic';
  return (
    <>
      <button
        data-testid="topic-model-override"
        disabled={disabled}
        title="Choose a model and reasoning level for this topic's tasks. Automatic delegates each task by intensity."
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
          if (models && !models.length) loadAiModels(service);
        }}
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border)] text-xs hover:text-[var(--foreground)] hover:bg-[var(--card)] disabled:opacity-50"
      >
        {text} <CaretDown size={11} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

export function TopicDetail() {
  const {
    topics,
    projects,
    selectedProjectId,
    openTopicId,
    openTopic,
    setTaskCompleted,
    updateTopic,
    deleteTopic,
    setTopicArchived,
    addTask,
    reorderTasks,
    workOnTask,
    confirm,
    pushError,
  } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);
  const canWork = !!project?.folderPath && !project.folderMissing;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const topic = topics.find((t) => t.id === openTopicId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [newTask, setNewTask] = useState('');
  const [context, setContext] = useState<TopicContextFile | null>(null);
  const done = topic?.tasks.filter((t) => t.completed).length ?? 0;

  // Reset local drafts when a different topic opens.
  useEffect(() => {
    setTitle(topic?.title ?? '');
    setDescription(topic?.description ?? '');
    setNewTask('');
    setContext(null);
  }, [topic?.id]);

  // Claude adds to the context file as it finishes tasks, so reload when the done count changes.
  const topicId = topic?.id;
  useEffect(() => {
    if (selectedProjectId === null || topicId === undefined || topicId < 0) return;
    let stale = false;
    api.getTopicContext(selectedProjectId, topicId).then(
      (file) => {
        if (!stale) setContext(file);
      },
      (e) => {
        if (!stale) pushError(e);
      },
    );
    return () => {
      stale = true;
    };
  }, [selectedProjectId, topicId, done, pushError]);

  if (!topic) return null;

  const saveTitle = () => {
    const t = title.trim();
    if (!t) setTitle(topic.title);
    else if (t !== topic.title) updateTopic(topic.id, { title: t });
  };
  const saveDescription = () => {
    if (description !== topic.description) updateTopic(topic.id, { description });
  };
  const submitTask = () => {
    const t = newTask.trim();
    if (!t) return;
    addTask(topic.id, t);
    setNewTask('');
  };

  // Closing can unmount the inputs before their blur fires, so flush drafts here.
  const close = () => {
    saveTitle();
    saveDescription();
    openTopic(null);
  };
  // Archiving closes the topic too, so flush drafts the same way.
  const archive = () => {
    saveTitle();
    saveDescription();
    setTopicArchived(topic.id, true);
  };
  // Unticks every done task. The context file is a record of past work, so it stays as is.
  const resetTasks = async () => {
    const doneTasks = topic.tasks.filter((t) => t.completed);
    if (doneTasks.length === 0) return;
    if (!(await confirm({ title: 'Reset tasks?', message: `${doneTasks.length} completed task(s) in "${topic.title}" will be marked as incomplete.` }))) return;
    await Promise.all(doneTasks.map((t) => setTaskCompleted(t.id, false)));
  };
  // Hands one task to Claude in the Terminal; the topic closes so the terminal is visible.
  const work = (taskId: number) => {
    saveTitle();
    saveDescription();
    workOnTask(taskId);
  };

  const tasks = [...topic.tasks].sort(bySortOrder);
  // Prerequisites are the user's own work and sit above the agent tasks.
  const prerequisites = tasks.filter((t) => t.prerequisite && !t.followUp);
  const followUps = tasks.filter((t) => t.prerequisite && t.followUp);
  const agentTasks = tasks.filter((t) => !t.prerequisite);
  // Follow-ups are done after the agent tasks, so only the other prerequisites block.
  const openPrerequisites = prerequisites.filter((t) => !t.completed).length;
  const openFollowUps = followUps.filter((t) => !t.completed).length;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    // Each section has its own order; a task can't be dragged across (use the Mine/Agent button).
    const sections = [prerequisites, agentTasks, followUps];
    const group = sections.find((g) => g.some((t) => t.id === from));
    if (!group || !group.some((t) => t.id === to)) return;
    const ids = group.map((t) => t.id);
    const moved = arrayMove(ids, ids.indexOf(from), ids.indexOf(to));
    reorderTasks(topic.id, sections.flatMap((g) => (g === group ? moved : g.map((t) => t.id))));
  };

  return (
    <Modal onClose={close}>
      <div data-testid="topic-detail" className="p-5 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <input
            aria-label="Topic title"
            className="flex-1 text-lg font-semibold bg-transparent outline-none border-b border-transparent focus:border-[var(--primary)] select-text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <button className="p-1 rounded hover:bg-[var(--card)]" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
          {topic.archivedAt && <span data-testid="topic-archived-label">Archived</span>}
          <div className="ml-auto flex items-center gap-3">
            {project?.displayType !== 'personal' && (
              <>
                <ModelFamilySwitch value={topic.modelFamily} disabled={topic.id < 0} onChange={(modelFamily) => updateTopic(topic.id, { modelFamily })} />
                <ModelOverrideMenu topic={topic} disabled={topic.id < 0} />
              </>
            )}
            {canWork && <SessionSwitch sameSession={topic.sameSession} disabled={topic.id < 0} onChange={(sameSession) => updateTopic(topic.id, { sameSession })} />}
          </div>
        </div>

        <textarea
          aria-label="Topic description"
          className="w-full min-h-24 px-3 py-2 text-sm rounded border border-[var(--border)] bg-[var(--card)] outline-none focus:border-[var(--primary)] resize-y select-text"
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
        />

        <div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            {prerequisites.length > 0 && (
              <section data-testid="topic-prerequisites" className="mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1">
                  Prerequisites
                  <span className="ml-2 normal-case tracking-normal tabular-nums">
                    {openPrerequisites === 0 ? 'all met' : `${openPrerequisites} to do`}
                  </span>
                </h3>
                <p className="text-xs text-[var(--muted-foreground)] mb-2">Work for you to do. The tasks below wait until these are done.</p>
                <ul className="flex flex-col rounded border border-[var(--border)] bg-[var(--card)]/40 py-1">
                  <SortableContext items={prerequisites.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    {prerequisites.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </SortableContext>
                </ul>
              </section>
            )}
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-2">Tasks</h3>
            <ul className="flex flex-col">
              <SortableContext items={agentTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {agentTasks.map((t) => (
                  <TaskRow key={t.id} task={t} blocked={openPrerequisites > 0} onWork={canWork ? () => work(t.id) : undefined} />
                ))}
              </SortableContext>
              {agentTasks.length === 0 && <li className="px-2 py-1 text-sm text-[var(--muted-foreground)]">{tasks.length === 0 ? 'No tasks yet.' : 'No agent tasks.'}</li>}
            </ul>
            {followUps.length > 0 && (
              <section data-testid="topic-follow-ups" className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1">
                  Follow-up
                  <span className="ml-2 normal-case tracking-normal tabular-nums">{openFollowUps === 0 ? 'all done' : `${openFollowUps} to do`}</span>
                </h3>
                <p className="text-xs text-[var(--muted-foreground)] mb-2">Work for you to do after the tasks above. Nothing waits on these.</p>
                <ul className="flex flex-col rounded border border-[var(--border)] bg-[var(--card)]/40 py-1">
                  <SortableContext items={followUps.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    {followUps.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </SortableContext>
                </ul>
              </section>
            )}
          </DndContext>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitTask();
            }}
          >
            <input
              aria-label="New task"
              className="flex-1 px-2 py-1 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text"
              placeholder="Add a task"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
            />
            <button type="submit" className="px-3 py-1 text-sm rounded bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-50" disabled={!newTask.trim()}>
              Add
            </button>
          </form>
        </div>

        {context?.exists && (
          <div data-testid="topic-context">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-2" title={context.path}>
              Context
            </h3>
            <pre className="max-h-64 overflow-y-auto px-3 py-2 text-xs font-sans whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--card)] select-text">
              {context.content.trim()}
            </pre>
          </div>
        )}

        <div className="flex justify-between border-t border-[var(--border)] pt-3">
          <div className="flex items-center gap-1">
            {topic.archivedAt ? (
              <button
                className="flex items-center gap-1.5 px-3 py-1 text-sm rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]"
                title="Put this topic back on the board"
                onClick={() => setTopicArchived(topic.id, false)}
              >
                <ArrowUUpLeft size={14} /> Restore topic
              </button>
            ) : (
              <button
                className="flex items-center gap-1.5 px-3 py-1 text-sm rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]"
                title="Hide this topic from the board. You can restore it from Archived."
                onClick={archive}
              >
                <Archive size={14} /> Archive topic
              </button>
            )}
            <button
              data-testid="topic-reset-tasks"
              className="flex items-center gap-1.5 px-3 py-1 text-sm rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)] disabled:opacity-50 disabled:hover:bg-transparent"
              title="Mark every task in this topic as incomplete"
              disabled={done === 0}
              onClick={resetTasks}
            >
              Reset tasks
            </button>
          </div>
          <button
            className="flex items-center gap-1.5 px-3 py-1 text-sm rounded text-red-400 hover:bg-red-950/50"
            onClick={async () => {
              if (await confirm({ title: 'Delete topic?', message: `"${topic.title}" and its ${topic.tasks.length} task(s) will be deleted.` }))
                deleteTopic(topic.id);
            }}
          >
            <Trash2 size={14} /> Delete topic
          </button>
        </div>
      </div>
    </Modal>
  );
}
