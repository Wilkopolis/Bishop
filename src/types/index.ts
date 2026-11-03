export const CATEGORIES = ['RIGHT_NOW', 'SOON', 'LATER', 'BACKLOG'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  folderId: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  topicId: number;
  title: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
  completedAt: string | null;
}

export interface Topic {
  id: number;
  title: string;
  description: string;
  category: Category;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
}

export interface Tree {
  folders: Folder[];
  projects: Project[];
}
