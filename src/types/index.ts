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
  /** Optional one-line description shown next to the project title (max 200 chars). */
  tagline: string | null;
}

export const MAX_TAGLINE_LENGTH = 200;

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

export interface SearchHit {
  projectId: number;
  projectName: string;
  topicId: number;
  topicTitle: string;
  category: Category;
  matchKind: 'title' | 'description' | 'task';
  snippet: string;
}

export interface BackupInfo {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

export interface WhisperStatus {
  model: string;
  modelPath: string;
  state: 'missing' | 'downloading' | 'error' | 'ready' | 'loaded';
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  backend: string | null;
  runtimeInfo: string | null;
}

export interface VoiceStatus {
  whisper: WhisperStatus;
  claude: { found: boolean; path: string | null };
}

export interface Transcription {
  text: string;
  backend: string;
  audioSeconds: number;
  elapsedMs: number;
  loadMs: number;
}

export interface TopicDraft {
  title: string;
  description: string;
  category: Category;
  tasks: string[];
}
