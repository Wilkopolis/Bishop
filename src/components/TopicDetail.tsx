import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowRight, Check, GripVertical, Trash2, X } from './icons';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBishopStore } from '../store/useBishopStore';
import type { Task } from '../types';
import { sortTasks } from './categories';
import { CategorySelect } from './ProjectOverview';
import { InlineInput, Modal } from './ui';

function TaskRow({ task, onWork }: { task: Task; onWork?: () => void }) {
  const { setTaskCompleted, renameTask, deleteTask } = useBishopStore();
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
      className={`group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--card)] ${pending ? 'opacity-60' : ''} ${
        isDragging ? 'relative z-10 bg-[var(--card)] shadow-lg' : ''
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        title="Drag to reorder (or focus and press Space, then arrow keys)"
        aria-label={`Reorder ${task.title}`}
        className="shrink-0 -ml-1 p-0.5 rounded cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 focus-visible:opacity-100"
      >
        <GripVertical size={14} />
      </button>
      <button
        title={task.completed ? 'Mark open' : 'Complete'}
        disabled={pending}
        onClick={() => setTaskCompleted(task.id, !task.completed)}
        className={`shrink-0 w-4 h-4 rounded border grid place-items-center ${
          task.completed ? 'bg-[var(--primary)] border-[var(--primary)] text-white' : 'border-[var(--muted-foreground)] hover:border-[var(--primary)]'
        }`}
      >
        {task.completed && <Check size={12} />}
      </button>
      {editing ? (
        <InlineInput initial={task.title} onCommit={(t) => { setEditing(false); renameTask(task.id, t); }} onCancel={() => setEditing(false)} />
      ) : (
        <span
          className={`flex-1 text-sm break-words select-text ${task.completed ? 'line-through text-[var(--muted-foreground)]' : ''}`}
          onDoubleClick={() => !pending && setEditing(true)}
        >
          {task.title}
        </span>
      )}
      {onWork && !task.completed && !pending && (
        <button
          title="Work on this task with Claude (opens the Terminal)"
          aria-label={`Work on ${task.title} with Claude`}
          onClick={onWork}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-70 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--primary-text)]"
        >
          <ArrowRight size={14} />
        </button>
      )}
      <button
        title="Remove task"
        disabled={pending}
        onClick={() => deleteTask(task.id)}
        className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-red-400"
      >
        <X size={14} />
      </button>
    </li>
  );
}

export function TopicDetail() {
  const { topics, projects, selectedProjectId, openTopicId, openTopic, updateTopic, deleteTopic, addTask, moveTopic, reorderTasks, workOnTask, confirm } =
    useBishopStore();
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

  // Reset local drafts when a different topic opens.
  useEffect(() => {
    setTitle(topic?.title ?? '');
    setDescription(topic?.description ?? '');
    setNewTask('');
  }, [topic?.id]);

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
  // Hands one task to Claude in the Terminal; the topic closes so the terminal is visible.
  const work = (taskId: number) => {
    saveTitle();
    saveDescription();
    workOnTask(taskId);
  };

  const tasks = sortTasks(topic.tasks);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = tasks.map((t) => t.id);
    reorderTasks(topic.id, arrayMove(ids, ids.indexOf(Number(active.id)), ids.indexOf(Number(over.id))));
  };
  const done = topic.tasks.filter((t) => t.completed).length;

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
          <span>Category</span>
          <CategorySelect value={topic.category} onChange={(category) => moveTopic(topic.id, category, Number.MAX_SAFE_INTEGER)} className="text-sm" />
          <span className="ml-auto tabular-nums">
            {done}/{topic.tasks.length} done
          </span>
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
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-2">Tasks</h3>
          <ul className="flex flex-col">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} onWork={canWork ? () => work(t.id) : undefined} />
                ))}
              </SortableContext>
            </DndContext>
            {tasks.length === 0 && <li className="px-2 py-1 text-sm text-[var(--muted-foreground)]">No tasks yet.</li>}
          </ul>
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

        <div className="flex justify-end border-t border-[var(--border)] pt-3">
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
