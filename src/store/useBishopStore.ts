import { create } from 'zustand';
import { api } from '../api/client';
import type { Folder, Project, Topic } from '../types';

interface BishopState {
  folders: Folder[];
  projects: Project[];
  selectedProjectId: number | null;
  topics: Topic[];
  loading: boolean;
  error: string | null;

  loadTree: () => Promise<void>;
  createProject: (name: string, folderId?: number | null) => Promise<Project | undefined>;
  createFolder: (name: string, parentId?: number | null) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  selectProject: (id: number | null) => Promise<void>;
  clearError: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useBishopStore = create<BishopState>((set, get) => ({
  folders: [],
  projects: [],
  selectedProjectId: null,
  topics: [],
  loading: false,
  error: null,

  loadTree: async () => {
    set({ loading: true });
    try {
      const tree = await api.tree();
      set({ folders: tree.folders, projects: tree.projects, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: message(e) });
    }
  },

  createProject: async (name, folderId = null) => {
    try {
      const project = await api.createProject(name, folderId);
      set((s) => ({ projects: [...s.projects, project] }));
      await get().selectProject(project.id);
      return project;
    } catch (e) {
      set({ error: message(e) });
    }
  },

  createFolder: async (name, parentId = null) => {
    try {
      const folder = await api.createFolder(name, parentId);
      set((s) => ({ folders: [...s.folders, folder] }));
    } catch (e) {
      set({ error: message(e) });
    }
  },

  renameProject: async (id, name) => {
    try {
      const updated = await api.updateProject(id, { name });
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }));
    } catch (e) {
      set({ error: message(e) });
    }
  },

  deleteProject: async (id) => {
    try {
      await api.deleteProject(id);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        ...(s.selectedProjectId === id ? { selectedProjectId: null, topics: [] } : {}),
      }));
    } catch (e) {
      set({ error: message(e) });
    }
  },

  selectProject: async (id) => {
    set({ selectedProjectId: id, topics: [] });
    if (id === null) return;
    try {
      const topics = await api.listTopics(id);
      if (get().selectedProjectId === id) set({ topics });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  clearError: () => set({ error: null }),
}));
