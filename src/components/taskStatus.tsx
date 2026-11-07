import { useBishopStore } from '../store/useBishopStore';
import { clampComplexity, complexityColor, COMPLEXITY_COLORS, type Task, type Topic } from '../types';

export { complexityColor, COMPLEXITY_COLORS };

/** A colored dot showing a task's 1 to 10 complexity rating. */
export function TaskComplexityDot({
  complexity,
  completed = false,
  testId = 'task-complexity',
  className = '',
}: {
  complexity: number;
  completed?: boolean;
  testId?: string;
  className?: string;
}) {
  const c = clampComplexity(complexity ?? 5);
  return (
    <span
      data-testid={testId}
      data-complexity={c}
      data-complexity-color={COMPLEXITY_COLORS[c]}
      title={`Complexity ${c}/10`}
      aria-label={`Complexity ${c} of 10`}
      style={{ backgroundColor: complexityColor(c) }}
      className={`shrink-0 w-2.5 h-2.5 rounded-full ${completed ? 'opacity-50' : ''} ${className}`}
    />
  );
}

/** Where a task stands: done, being worked on by Claude, queued for a turn, or not picked up by anyone. */
export type TaskStatus = 'complete' | 'active' | 'pending' | 'unassigned';

/** Display order, left to right in progress bars. */
const TASK_STATUSES: TaskStatus[] = ['complete', 'active', 'pending', 'unassigned'];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  complete: 'Complete',
  active: 'Active',
  pending: 'Pending',
  unassigned: 'Unassigned',
};

const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  complete: 'var(--task-complete)',
  active: 'var(--task-active)',
  pending: 'var(--task-pending)',
  unassigned: 'var(--task-unassigned)',
};

/** Complete comes first: a finished task's session can still be open for a moment. */
export function taskStatus(task: Task, activeTaskIds: number[]): TaskStatus {
  if (task.completed) return 'complete';
  if (activeTaskIds.includes(task.id)) return 'active';
  return task.queued ? 'pending' : 'unassigned';
}

/**
 * True while a task in the topic is being worked on, or waiting its turn behind a live session.
 * `activeTaskIds` covers the whole project. With no live session nothing will start a queued task,
 * so the task stays pending (the queue survives a restart) but its topic doesn't count as active.
 */
export function hasSession(topic: Topic, activeTaskIds: number[]): boolean {
  if (activeTaskIds.length === 0) return false;
  return topic.tasks.some((t) => {
    const status = taskStatus(t, activeTaskIds);
    return status === 'active' || status === 'pending';
  });
}

/** Past this many tasks the dividers would run together into stripes, so the bar leaves them out. */
const MAX_DIVIDED_TASKS = 40;

/**
 * A bar split by task status. The caller sets its size and track color.
 * `dividers` marks each task with a thin line in the card color, so use it on bars that sit on a card.
 */
export function TaskStatusBar({ tasks, className = '', testId, dividers = false }: { tasks: Task[]; className?: string; testId?: string; dividers?: boolean }) {
  const activeTaskIds = useBishopStore((s) => s.activeTaskIds);
  const counts: Record<TaskStatus, number> = { complete: 0, active: 0, pending: 0, unassigned: 0 };
  for (const t of tasks) counts[taskStatus(t, activeTaskIds)]++;
  const shown = TASK_STATUSES.filter((s) => counts[s] > 0);
  return (
    <div
      data-testid={testId}
      title={shown.map((s) => `${counts[s]} ${TASK_STATUS_LABELS[s].toLowerCase()}`).join(', ')}
      className={`relative flex rounded overflow-hidden ${className}`}
    >
      {shown.map((s) => (
        <div
          key={s}
          data-status={s}
          className="h-full transition-[width]"
          style={{ width: `${(counts[s] / tasks.length) * 100}%`, backgroundColor: TASK_STATUS_COLORS[s] }}
        />
      ))}
      {dividers &&
        tasks.length <= MAX_DIVIDED_TASKS &&
        tasks.slice(1).map((t, i) => (
          <div
            key={t.id}
            data-testid="task-divider"
            // No centering transform: a half-pixel shift blurs the line across two pixels.
            className="absolute inset-y-0 w-px bg-[var(--card)]"
            style={{ left: `${((i + 1) / tasks.length) * 100}%` }}
          />
        ))}
    </div>
  );
}
