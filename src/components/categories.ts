import type { Category, ProjectCategory } from '../types';

export const categoryLabel = (categories: ProjectCategory[] | undefined, category: Category) => categories?.find((c) => c.key === category)?.name ?? '';

const DEFAULT_DOTS: Record<string, string> = {
  RIGHT_NOW: 'bg-orange-500',
  SOON: 'bg-amber-400',
  LATER: 'bg-rose-400',
  BACKLOG: 'bg-stone-500',
};

const ADDED_DOTS = ['bg-yellow-500', 'bg-red-400', 'bg-lime-500', 'bg-orange-300', 'bg-pink-400', 'bg-stone-300'];

/** Added categories pick a color from their key, so it stays the same when other categories come and go. */
export const categoryDot = (category: Category) =>
  DEFAULT_DOTS[category] ?? ADDED_DOTS[[...category].reduce((sum, c) => sum + c.charCodeAt(0), 0) % ADDED_DOTS.length];

/** The Active section on the board. It shows topics with sessions and is not a stored category. */
export const ACTIVE_LABEL = 'Active';
