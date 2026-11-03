import type { Category, Task } from '../types';

export const CATEGORY_LABELS: Record<Category, string> = {
  RIGHT_NOW: 'Right now',
  SOON: 'Soon',
  LATER: 'Later',
  BACKLOG: 'Backlog',
};

export const CATEGORY_ACCENTS: Record<Category, string> = {
  RIGHT_NOW: 'border-t-orange-500',
  SOON: 'border-t-amber-400',
  LATER: 'border-t-rose-400',
  BACKLOG: 'border-t-stone-500',
};

/** Open tasks first (by sort order), completed tasks after. */
export const sortTasks = (tasks: Task[]) =>
  [...tasks].sort((a, b) => Number(a.completed) - Number(b.completed) || a.sortOrder - b.sortOrder || a.id - b.id);
