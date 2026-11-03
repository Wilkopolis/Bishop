import { create } from 'zustand';
import { api } from '../api/client';
import type { Category, Folder, Project, Task, Topic, TopicDraft } from '../types';

export interface Toast {
  id: number;
  message: string;
}

interface BishopState {
  folders: Folder[];
  projects: Project[];
  selectedProjectId: number | null;
  topics: Topic[];
  openTopicId: number | null;
  loading: boolean;
  toasts: Toast[];

  loadTree: () => Promise<void>;

  createFolder: (name: string, parentId?: number | null) => Promise<void>;
  renameFolder: (id: number, name: string) => Promise<void>;
  deleteFolder: (id: number) => Promise<void>;

  createProject: (name: string, folderId?: number | null) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  moveProject: (id: number, folderId: number | null) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  selectProject: (id: number | null) => Promise<void>;

  createTopic: (title: string, category: Category) => Promise<void>;
  updateTopic: (id: number, patch: { title?: string; description?: string; category?: Category }) => Promise<void>;
  deleteTopic: (id: number) => Promise<void>;
  saveTopicDraft: (draft: TopicDraft) => Promise<boolean>;
  openTopic: (id: number | null) => void;

  addTask: (topicId: number, title: string) => Promise<void>;
  setTaskCompleted: (taskId: number, completed: boolean) => Promise<void>;
  renameTask: (taskId: number, title: string) => Promise<void>;
  deleteTask: (taskId: number) => Promise<void>;

  pushError: (e: unknown) => void;
  dismissToast: (id: number) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => new Date().toISOString();

// Optimistically created rows get negative ids until the server responds.
let tempId = -1;
let toastId = 1;

// Remember the last opened project per viewer (best effort; storage may be unavailable).
const LAST_PROJECT_KEY = 'bishop_last_project';
const readLastProject = () => {
  try {
    const v = Number(localStorage.getItem(LAST_PROJECT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeLastProject = (id: number | null) => {
  try {
    if (id === null) localStorage.removeItem(LAST_PROJECT_KEY);
    else localStorage.setItem(LAST_PROJECT_KEY, String(id));
  } catch {}
};

const mapTask = (topics: Topic[], taskId: number, fn: (t: Task) => Task): Topic[] =>
  topics.map((topic) =>
    topic.tasks.some((t) => t.id === taskId) ? { ...topic, tasks: topic.tasks.map((t) => (t.id === taskId ? fn(t) : t)) } : topic,
  );

export const useBishopStore = create<BishopState>((set, get) => {
  /**
   * Apply `optimistic` immediately, run `request`, and restore the previous
   * tree/topics snapshot (plus an error toast) if it fails.
   */
  async function optimistic<T>(
    apply: (s: BishopState) => Partial<BishopState>,
    request: () => Promise<T>,
    commit?: (result: T, s: BishopState) => Partial<BishopState>,
  ) {
    const { folders, projects, topics, selectedProjectId } = get();
    set(apply(get()));
    try {
      const result = await request();
      if (commit) set(commit(result, get()));
    } catch (e) {
      // Only roll back topics if the user is still on the same project.
      set({
        folders,
        projects,
        ...(get().selectedProjectId === selectedProjectId ? { topics } : {}),
      });
      get().pushError(e);
    }
  }

  const projectId = () => {
    const id = get().selectedProjectId;
    if (id === null) throw new Error('No project selected');
    return id;
  };

  return {
    folders: [],
    projects: [],
    selectedProjectId: null,
    topics: [],
    openTopicId: null,
    loading: false,
    toasts: [],

    loadTree: async () => {
      set({ loading: true });
      try {
        const tree = await api.tree();
        set({ folders: tree.folders, projects: tree.projects });
        const last = readLastProject();
        if (get().selectedProjectId === null && last !== null && tree.projects.some((p) => p.id === last)) {
          void get().selectProject(last);
        }
      } catch (e) {
        get().pushError(e);
      } finally {
        set({ loading: false });
      }
    },

    // ---------------------------------------------------------- folders

    createFolder: async (name, parentId = null) => {
      try {
        const folder = await api.createFolder(name, parentId);
        set((s) => ({ folders: [...s.folders, folder] }));
      } catch (e) {
        get().pushError(e);
      }
    },

    renameFolder: (id, name) =>
      optimistic(
        (s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) }),
        () => api.updateFolder(id, { name }),
        (folder, s) => ({ folders: s.folders.map((f) => (f.id === id ? folder : f)) }),
      ),

    // Server moves children up to the deleted folder's parent; mirror that locally.
    deleteFolder: (id) =>
      optimistic(
        (s) => {
          const parentId = s.folders.find((f) => f.id === id)?.parentId ?? null;
          return {
            folders: s.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId } : f)),
            projects: s.projects.map((p) => (p.folderId === id ? { ...p, folderId: parentId } : p)),
          };
        },
        () => api.deleteFolder(id),
      ),

    // --------------------------------------------------------- projects

    createProject: async (name, folderId = null) => {
      try {
        const project = await api.createProject(name, folderId);
        set((s) => ({ projects: [...s.projects, project] }));
        await get().selectProject(project.id);
      } catch (e) {
        get().pushError(e);
      }
    },

    renameProject: (id, name) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }),
        () => api.updateProject(id, { name }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    moveProject: (id, folderId) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, folderId } : p)) }),
        () => api.updateProject(id, { folderId }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    deleteProject: async (id) => {
      if (get().selectedProjectId === id) set({ selectedProjectId: null, topics: [], openTopicId: null });
      await optimistic((s) => ({ projects: s.projects.filter((p) => p.id !== id) }), () => api.deleteProject(id));
    },

    selectProject: async (id) => {
      set({ selectedProjectId: id, topics: [], openTopicId: null });
      writeLastProject(id);
      if (id === null) return;
      try {
        const topics = await api.listTopics(id);
        if (get().selectedProjectId === id) set({ topics });
      } catch (e) {
        get().pushError(e);
      }
    },

    // ----------------------------------------------------------- topics

    createTopic: async (title, category) => {
      const pid = projectId();
      const id = tempId--;
      const draft: Topic = { id, title, description: '', category, sortOrder: Number.MAX_SAFE_INTEGER, createdAt: now(), updatedAt: now(), tasks: [] };
      await optimistic(
        (s) => ({ topics: [...s.topics, draft] }),
        () => api.createTopic(pid, { title, category }),
        (topic, s) => ({
          topics: s.topics.map((t) => (t.id === id ? topic : t)),
          openTopicId: s.openTopicId === id ? topic.id : s.openTopicId,
        }),
      );
    },

    updateTopic: async (id, patch) => {
      if (id < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: s.topics.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
        () => api.updateTopic(pid, id, patch),
        // Keep local tasks: they may have pending optimistic changes of their own.
        (topic, s) => ({ topics: s.topics.map((t) => (t.id === id ? { ...topic, tasks: t.tasks } : t)) }),
      );
    },

    deleteTopic: async (id) => {
      if (id < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: s.topics.filter((t) => t.id !== id), openTopicId: s.openTopicId === id ? null : s.openTopicId }),
        () => api.deleteTopic(pid, id),
      );
    },

    // Not optimistic: the review dialog stays open (with its edits) until this succeeds.
    saveTopicDraft: async (draft) => {
      const pid = projectId();
      let topic: Topic;
      try {
        topic = await api.createTopic(pid, { title: draft.title, description: draft.description, category: draft.category });
      } catch (e) {
        get().pushError(e);
        return false;
      }
      const tasks: Task[] = [];
      let failed = 0;
      for (const title of draft.tasks) {
        try {
          tasks.push(await api.addTask(pid, topic.id, title));
        } catch {
          failed++;
        }
      }
      if (get().selectedProjectId === pid) set((s) => ({ topics: [...s.topics, { ...topic, tasks }] }));
      if (failed) get().pushError(new Error(`Topic saved, but ${failed} task(s) couldn't be added.`));
      return true;
    },

    openTopic: (id) => set({ openTopicId: id }),

    // ------------------------------------------------------------ tasks

    addTask: async (topicId, title) => {
      if (topicId < 0) return; // topic not saved yet
      const pid = projectId();
      const id = tempId--;
      const draft: Task = { id, topicId, title, completed: false, sortOrder: Number.MAX_SAFE_INTEGER, createdAt: now(), completedAt: null };
      await optimistic(
        (s) => ({ topics: s.topics.map((t) => (t.id === topicId ? { ...t, tasks: [...t.tasks, draft] } : t)) }),
        () => api.addTask(pid, topicId, title),
        (task, s) => ({ topics: mapTask(s.topics, id, () => task) }),
      );
    },

    setTaskCompleted: async (taskId, completed) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, completed, completedAt: completed ? now() : null })) }),
        () => api.completeTask(pid, taskId, completed),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    renameTask: async (taskId, title) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, title })) }),
        () => api.updateTask(pid, taskId, { title }),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    deleteTask: async (taskId) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: s.topics.map((t) => ({ ...t, tasks: t.tasks.filter((k) => k.id !== taskId) })) }),
        () => api.deleteTask(pid, taskId),
      );
    },

    // ----------------------------------------------------------- toasts

    pushError: (e) => {
      const id = toastId++;
      set((s) => ({ toasts: [...s.toasts, { id, message: message(e) }] }));
      setTimeout(() => get().dismissToast(id), 5000);
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
