import { create } from 'zustand';
import { api } from '../api/client';
import { preparePicture } from '../images';
import { clampComplexity, DEFAULT_SEVERITY, rateTaskComplexity, SEVERITIES,type AiService, type Category, type Folder, type ModelFamily, type Project, type DisplayType, type ProjectCategory, type QueuedCount, type RefinedTopicResponse, type Task, type TerminalInfo, type TerminalModel, type Topic, type TopicDraft } from '../types';

export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

interface BishopState {
  folders: Folder[];
  projects: Project[];
  selectedProjectId: number | null;
  topics: Topic[];
  /** The sidebar project a dragged topic is hovering over, so its row can light up as a drop target. */
  topicDropProjectId: number | null;
  openTopicId: number | null;
  loading: boolean;
  toasts: Toast[];
  confirmRequest: ConfirmRequest | null;
  /** Bottom terminal panel. Starts closed; `loadTree` opens it again after a reload if it was open and has a session to show. */
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
  /** Set by a button that opens the Terminal: the visible terminal view takes focus once, then clears it. */
  terminalWantsFocus: boolean;
  /** Open the Terminal and focus it. For buttons only; opening it any other way leaves focus alone. */
  launchTerminal: () => void;
  clearTerminalFocus: () => void;
  /** Silent mode: when on, Bishop does not flash in the taskbar. Saved in localStorage. */
  silentMode: boolean;
  setSilentMode: (on: boolean) => void;
  /** Performance charts dialog, opened from the title bar. */
  chartsOpen: boolean;
  setChartsOpen: (open: boolean) => void;
  /** Complexity delegation dialog, opened from the title bar. */
  delegationOpen: boolean;
  setDelegationOpen: (open: boolean) => void;
  /** The task whose complexity picker is open, from a click on its complexity bubble in the topic view. Null: closed. */
  complexityPickerTaskId: number | null;
  openComplexityPicker: (taskId: number | null) => void;
  /** What new sessions run, task sessions included. A session already running keeps its CLI. */
  aiService: AiService;
  setAiService: (service: AiService) => void;
  /** The model and reasoning level new sessions of each CLI run on, for a project with none saved. Null: the CLI's own default. */
  aiModels: Record<AiService, string | null>;
  aiEfforts: Record<AiService, string | null>;
  setAiChoice: (service: AiService, model: string | null, effort: string | null) => void;
  /** The models each CLI offers. Missing: not loaded yet. Empty: the CLI couldn't answer. */
  aiModelLists: Partial<Record<AiService, TerminalModel[]>>;
  loadAiModels: (service: AiService) => Promise<TerminalModel[]>;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** "Work on this task": the terminal panel picks this up and starts a session of the selected CLI, on the model and reasoning saved on the project. */
  workRequest: { projectId: number; taskId: number } | null;
  workOnTask: (taskId: number) => void;
  clearWorkRequest: () => void;
  /** A click in the session feed: the terminal panel picks this up and shows the session. */
  reopenRequest: { projectId: number; sessionId: string } | null;
  reopenSession: (projectId: number, sessionId: string) => void;
  clearReopenRequest: () => void;
  /** Reloads the selected project's topics (e.g. after Claude ticks a task). Skipped while edits are in flight. */
  refreshTopics: () => Promise<void>;
  /** Tasks in the selected project that Claude is working on now. While there are any, starting another task becomes queueing it. */
  activeTaskIds: number[];
  refreshActiveTasks: () => Promise<void>;
  /** Marks a task as running now, without waiting for the next refresh. Its topic moves to Active at once. */
  markTaskActive: (projectId: number, taskId: number) => void;
  /** Every project's Terminal sessions, in the host's order. Null until the first load, when no project's state is known yet. */
  sessions: TerminalInfo[] | null;
  /** Every project's queued task count. Loads with the sessions, because the frontend only has the selected project's topics. */
  queuedCounts: QueuedCount[];
  refreshSessions: () => Promise<void>;

  loadTree: () => Promise<void>;

  createFolder: (name: string, parentId?: number | null) => Promise<void>;
  renameFolder: (id: number, name: string) => Promise<void>;
  deleteFolder: (id: number) => Promise<void>;

  /** Creates a project with its working folder. Resolves false (and leaves the dialog open) on error. */
  createProject: (name: string, folderPath: string, folderId?: number | null) => Promise<boolean>;
  /** Links (or relinks) a project's working folder. Files are never moved. */
  linkProjectFolder: (id: number, folderPath: string) => Promise<boolean>;
  /** Dialogs: new project (with the sidebar folder it goes in), change folder, AGENTS.md editor. */
  newProjectDialog: { folderId: number | null } | null;
  setNewProjectDialog: (d: { folderId: number | null } | null) => void;
  folderDialogFor: number | null;
  setFolderDialogFor: (id: number | null) => void;
  iconDialogFor: number | null;
  setIconDialogFor: (id: number | null) => void;
  agentsEditorFor: number | null;
  setAgentsEditorFor: (id: number | null) => void;
  refineTopicFor: number | null;
  setRefineTopicFor: (id: number | null) => void;
  renameProject: (id: number, name: string) => Promise<void>;
  setProjectIcon: (id: number, icon: string | null, iconColor: string | null) => Promise<void>;
  setProjectTagline: (id: number, tagline: string | null) => Promise<void>;
  /** Saves the AI service on the project, with its model and reasoning level. Null: the CLI's own default. */
  setProjectTerminalChoice: (id: number, kind: AiService, model: string | null, effort: string | null) => Promise<void>;
  setDisplayType: (id: number, displayType: DisplayType) => Promise<void>;
  /** Uploads (or replaces) a project's picture. The returned promise settles when done. */
  setProjectImage: (id: number, file: File) => Promise<void>;
  removeProjectImage: (id: number) => Promise<void>;
  /** Projects with an upload in progress. */
  uploadingImage: number[];
  /** Whether the overview's tagline editor is open (the sidebar menu can open it too). */
  editingTagline: boolean;
  setEditingTagline: (editing: boolean) => void;
  moveProject: (id: number, folderId: number | null) => Promise<void>;
  /** Drag and drop: put a project into a folder (null = root), before another project or at the end. */
  placeProject: (id: number, folderId: number | null, beforeId: number | null) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  selectProject: (id: number | null) => Promise<void>;

  /** Each project's categories in board order, by project id, loaded when a project is selected. */
  categories: Record<number, ProjectCategory[]>;
  /** Adds a category at the end of the board. */
  addCategory: (projectId: number, name: string) => Promise<void>;
  /** Saves a category's name. Shows it right away and puts the old name back if saving fails. */
  renameCategory: (projectId: number, category: Category, name: string) => Promise<void>;
  /** Removes a category. Its topics go to `moveTo`, which can be null only when it has none. */
  removeCategory: (projectId: number, category: Category, moveTo: Category | null) => Promise<void>;

  createTopic: (title: string, category: Category) => Promise<void>;
  updateTopic: (id: number, patch: { title?: string; description?: string; category?: Category; sameSession?: boolean; modelFamily?: ModelFamily; modelOverride?: string | null; effortOverride?: string | null }) => Promise<void>;
  deleteTopic: (id: number) => Promise<void>;
  /** Archives a topic (closing it if open), or restores it to its section. */
  setTopicArchived: (id: number, archived: boolean) => Promise<void>;
  saveTopicDraft: (draft: TopicDraft) => Promise<boolean>;
  refineTopicWithAnswers: (
    topicId: number,
    data: {
      answers?: string[];
      notes?: string;
      missing?: string[];
    },
  ) => Promise<RefinedTopicResponse | null>;
  /** Drag and drop: move a topic to `index` within `category`. */
  moveTopic: (id: number, category: Category, index: number) => Promise<void>;
  setTopicDropProject: (id: number | null) => void;
  /** Drag and drop: move a topic and its tasks to another project (dropped on it in the sidebar). */
  moveTopicToProject: (id: number, toProjectId: number) => Promise<void>;
  openTopic: (id: number | null) => void;

  addTask: (topicId: number, title: string, prerequisite?: boolean, complexity?: number) => Promise<void>;
  /** Personal projects: adds a task to a category, through its first topic (made, named after the category, if there is none). */
  addCategoryTask: (category: Category, categoryName: string, title: string) => Promise<void>;
  setTaskCompleted: (taskId: number, completed: boolean) => Promise<void>;
  setTaskQueued: (taskId: number, queued: boolean) => Promise<void>;
  setTaskPrerequisite: (taskId: number, prerequisite: boolean) => Promise<void>;
  setTaskFollowUp: (taskId: number, followUp: boolean) => Promise<void>;
  setTaskReply: (taskId: number, reply: string) => Promise<void>;
  setTaskComplexity: (taskId: number, complexity: number) => Promise<void>;
  renameTask: (taskId: number, title: string) => Promise<void>;
  deleteTask: (taskId: number) => Promise<void>;
  reorderTasks: (topicId: number, orderedIds: number[]) => Promise<void>;
  /**
   * Personal projects: moves a task to another category, to `index` among the target topic's tasks (the end
   * when null). The target is the category's first topic (made, named after the category, if there is none).
   * Changes the screen only: saving it needs a task-move endpoint, which comes with the persist task.
   */
  moveTaskToCategory: (taskId: number, category: Category, categoryName: string, index: number | null) => Promise<void>;

  confirm: (opts: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>;

  pushError: (e: unknown) => void;
  pushInfo: (message: string) => void;
  dismissToast: (id: number) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => new Date().toISOString();

// Optimistically created rows get negative ids until the server responds.
let tempId = -1;
let toastId = 1;
// Topics of projects we switched away from, so switching back doesn't start from an empty board.
const topicCache = new Map<number, Topic[]>();
// Optimistic requests still running; a background refresh then could undo them on screen.
let inFlight = 0;
// Counts optimistic edits, so a background refresh can tell its response was read before one of them.
let edits = 0;

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
const TERMINAL_OPEN_KEY = 'bishop_terminal_open';
const SILENT_MODE_KEY = 'bishop_silent_mode';

function readSilentMode(): boolean {
  try {
    return localStorage.getItem(SILENT_MODE_KEY) === '1';
  } catch {
    return false;
  }
}
const readTerminalOpen = () => {
  try {
    return localStorage.getItem(TERMINAL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
const AI_SERVICE_KEY = 'bishop_terminal_backend';
const readAiService = (): AiService => {
  try {
    return localStorage.getItem(AI_SERVICE_KEY) === 'antigravity' ? 'antigravity' : 'claude';
  } catch {
    return 'claude';
  }
};
const MODEL_KEY = 'bishop_terminal_model_'; // plus the CLI
const EFFORT_KEY = 'bishop_terminal_effort_'; // plus the CLI
// Antigravity model ids used to carry their level, such as gemini-4-argon-high. A saved one is read as the model and the level.
const LEVEL_IN_ID = /-(low|medium|high|xhigh|max)$/;
/** Null: the CLI's own default. */
const readModel = (service: AiService) => {
  try {
    const id = localStorage.getItem(MODEL_KEY + service) || null;
    return service === 'antigravity' ? (id?.replace(LEVEL_IN_ID, '') ?? null) : id;
  } catch {
    return null;
  }
};
/** Null: the CLI's own default. */
const readEffort = (service: AiService) => {
  try {
    const saved = localStorage.getItem(EFFORT_KEY + service);
    return saved || (service === 'antigravity' ? (localStorage.getItem(MODEL_KEY + service)?.match(LEVEL_IN_ID)?.[1] ?? null) : null);
  } catch {
    return null;
  }
};
/** The CLI a new session runs. A project with nothing saved uses the general choice. */
export const aiServiceFor = (project: Project | undefined, general: AiService) => project?.aiService ?? general;
/** What a new session of this CLI runs on. The pair stays together, so the level always fits the model. A project with nothing saved uses the general choice. */
export const aiChoiceFor = (
  project: Project | undefined,
  service: AiService,
  models: Record<AiService, string | null>,
  efforts: Record<AiService, string | null>,
) => {
  const model = service === 'claude' ? project?.claudeModel : project?.antigravityModel;
  const effort = service === 'claude' ? project?.claudeEffort : project?.antigravityEffort;
  // Empty is a saved choice: the CLI's own default.
  return model != null || effort != null ? { model: model || null, effort: effort || null } : { model: models[service], effort: efforts[service] };
};
const writeLastProject = (id: number | null) => {
  try {
    if (id === null) localStorage.removeItem(LAST_PROJECT_KEY);
    else localStorage.setItem(LAST_PROJECT_KEY, String(id));
  } catch {}
};

export const bySortOrder = (a: { sortOrder: number; id: number }, b: { sortOrder: number; id: number }) =>
  a.sortOrder - b.sortOrder || a.id - b.id;

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
    inFlight++;
    edits++;
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
    } finally {
      inFlight--;
    }
  }

  const projectId = () => {
    const id = get().selectedProjectId;
    if (id === null) throw new Error('No project selected');
    return id;
  };

  // A Terminal that was open comes back after a reload only if it has a session to show. It never opens just to start
  // one. Sessions end with the app, so after a restart it stays closed.
  const restoreTerminal = async () => {
    if (!readTerminalOpen()) return;
    const pid = get().selectedProjectId;
    const all = pid === null ? [] : await api.listTerminals(pid).catch(() => []);
    const running = all.some((t) => t.alive && !t.background);
    if (running || !get().terminalOpen) get().setTerminalOpen(running);
  };

  return {
    folders: [],
    projects: [],
    selectedProjectId: null,
    topics: [],
    topicDropProjectId: null,
    openTopicId: null,
    loading: false,
    toasts: [],
    confirmRequest: null,
    editingTagline: false,
    categories: {},
    // Not optimistic: the host makes the new category's key.
    addCategory: async (projectId, name) => {
      try {
        const categories = await api.addCategory(projectId, name);
        set((s) => ({ categories: { ...s.categories, [projectId]: categories } }));
      } catch (e) {
        get().pushError(e);
      }
    },
    renameCategory: async (projectId, category, name) => {
      const previous = get().categories[projectId] ?? [];
      const renamed = previous.map((c) => (c.key === category ? { ...c, name } : c));
      set((s) => ({ categories: { ...s.categories, [projectId]: renamed } }));
      try {
        const categories = await api.renameCategory(projectId, category, name);
        set((s) => ({ categories: { ...s.categories, [projectId]: categories } }));
      } catch (e) {
        set((s) => ({ categories: { ...s.categories, [projectId]: previous } }));
        get().pushError(e);
      }
    },
    // Not optimistic: the host decides where the moved topics land.
    removeCategory: async (projectId, category, moveTo) => {
      try {
        const { categories, topics } = await api.removeCategory(projectId, category, moveTo);
        const byId = new Map(topics.map((t) => [t.id, t]));
        set((s) => ({
          categories: { ...s.categories, [projectId]: categories },
          // Take category/order from the server but keep local tasks (they may have pending edits).
          topics:
            s.selectedProjectId === projectId
              ? s.topics.map((t) => {
                  const fresh = byId.get(t.id);
                  return fresh ? { ...t, category: fresh.category, sortOrder: fresh.sortOrder } : t;
                })
              : s.topics,
        }));
      } catch (e) {
        get().pushError(e);
      }
    },
    newProjectDialog: null,
    setNewProjectDialog: (d) => set({ newProjectDialog: d }),
    folderDialogFor: null,
    setFolderDialogFor: (id) => set({ folderDialogFor: id }),
    iconDialogFor: null,
    setIconDialogFor: (id) => set({ iconDialogFor: id }),
    agentsEditorFor: null,
    setAgentsEditorFor: (id) => set({ agentsEditorFor: id }),
    refineTopicFor: null,
    setRefineTopicFor: (id) => set({ refineTopicFor: id }),
    uploadingImage: [],
    setEditingTagline: (editing) => set({ editingTagline: editing }),
    terminalOpen: false,
    setTerminalOpen: (open) => {
      try {
        localStorage.setItem(TERMINAL_OPEN_KEY, open ? '1' : '0');
      } catch {}
      set({ terminalOpen: open, ...(open ? {} : { terminalWantsFocus: false }) });
    },
    terminalWantsFocus: false,
    launchTerminal: () => {
      get().setTerminalOpen(true);
      set({ terminalWantsFocus: true });
    },
    clearTerminalFocus: () => set({ terminalWantsFocus: false }),
    silentMode: readSilentMode(),
    setSilentMode: (on) => {
      try {
        localStorage.setItem(SILENT_MODE_KEY, on ? '1' : '0');
      } catch {}
      set({ silentMode: on });
    },
    chartsOpen: false,
    setChartsOpen: (open) => set({ chartsOpen: open }),
    delegationOpen: false,
    setDelegationOpen: (open) => set({ delegationOpen: open }),
    complexityPickerTaskId: null,
    openComplexityPicker: (taskId) => set({ complexityPickerTaskId: taskId }),
    aiService: readAiService(),
    setAiService: (service) => {
      try {
        localStorage.setItem(AI_SERVICE_KEY, service);
      } catch {}
      set({ aiService: service });
    },
    aiModels: { claude: readModel('claude'), antigravity: readModel('antigravity') },
    aiEfforts: { claude: readEffort('claude'), antigravity: readEffort('antigravity') },
    setAiChoice: (service, model, effort) => {
      try {
        if (model) localStorage.setItem(MODEL_KEY + service, model);
        else localStorage.removeItem(MODEL_KEY + service);
        if (effort) localStorage.setItem(EFFORT_KEY + service, effort);
        else localStorage.removeItem(EFFORT_KEY + service);
      } catch {}
      set((s) => ({ aiModels: { ...s.aiModels, [service]: model }, aiEfforts: { ...s.aiEfforts, [service]: effort } }));
    },
    aiModelLists: {},
    loadAiModels: async (service) => {
      // An empty list means the CLI couldn't answer. Asking again counts as loading.
      if (!get().aiModelLists[service]?.length) set((s) => ({ aiModelLists: { ...s.aiModelLists, [service]: undefined } }));
      const list = await api.terminalModels(service).catch(() => []);
      set((s) => ({ aiModelLists: { ...s.aiModelLists, [service]: list } }));
      return list;
    },
    searchOpen: false,
    setSearchOpen: (open) => set({ searchOpen: open }),

    workRequest: null,
    workOnTask: (taskId) => {
      const pid = get().selectedProjectId;
      if (pid === null || taskId < 0) return;
      set({ workRequest: { projectId: pid, taskId }, openTopicId: null });
      get().launchTerminal();
    },
    clearWorkRequest: () => set({ workRequest: null }),

    reopenRequest: null,
    reopenSession: (projectId, sessionId) => {
      // Set first: the panel must not start a session of its own for a project it is about to show.
      // Not in the background any more, so the session feed drops it now rather than on the next refresh.
      set((s) => ({
        reopenRequest: { projectId, sessionId },
        openTopicId: null,
        sessions: s.sessions?.map((t) => (t.id === sessionId ? { ...t, background: false } : t)) ?? null,
      }));
      if (get().selectedProjectId !== projectId) void get().selectProject(projectId);
      get().launchTerminal();
    },
    clearReopenRequest: () => set({ reopenRequest: null }),

    refreshTopics: async () => {
      const pid = get().selectedProjectId;
      if (pid === null || inFlight > 0) return;
      const editsBefore = edits;
      let fresh: Topic[];
      try {
        fresh = await api.listTopics(pid);
      } catch {
        return; // background refresh: stay quiet
      }
      const { topics, selectedProjectId } = get();
      if (selectedProjectId !== pid || inFlight > 0 || edits !== editsBefore) return;
      // Unsaved (negative id) topics and tasks stay until their own requests finish.
      if (topics.some((t) => t.id < 0 || t.tasks.some((k) => k.id < 0))) return;
      if (JSON.stringify(fresh) !== JSON.stringify(topics)) set({ topics: fresh });
    },

    activeTaskIds: [],
    refreshActiveTasks: async () => {
      const pid = get().selectedProjectId;
      if (pid === null) return;
      let sessions: TerminalInfo[];
      try {
        sessions = await api.listTerminals(pid);
      } catch {
        return; // background refresh: stay quiet
      }
      if (get().selectedProjectId !== pid) return;
      const ids = sessions.flatMap((t) => (t.taskRunning && t.taskId !== null ? [t.taskId] : []));
      if (JSON.stringify(ids) !== JSON.stringify(get().activeTaskIds)) set({ activeTaskIds: ids });
    },

    markTaskActive: (projectId, taskId) => {
      if (get().selectedProjectId !== projectId) return;
      // The host clears `queued` when a queued task starts, so do the same here.
      set((s) => ({
        activeTaskIds: s.activeTaskIds.includes(taskId) ? s.activeTaskIds : [...s.activeTaskIds, taskId],
        topics: mapTask(s.topics, taskId, (t) => (t.queued ? { ...t, queued: false, queuedAt: null } : t)),
      }));
    },

    sessions: null,
    queuedCounts: [],
    refreshSessions: async () => {
      let sessions: TerminalInfo[];
      let queuedCounts: QueuedCount[];
      try {
        [sessions, queuedCounts] = await Promise.all([api.listTerminals(), api.queuedTasks()]);
      } catch {
        return; // background refresh: stay quiet
      }
      if (JSON.stringify(sessions) !== JSON.stringify(get().sessions)) set({ sessions });
      if (JSON.stringify(queuedCounts) !== JSON.stringify(get().queuedCounts)) set({ queuedCounts });
    },

    loadTree: async () => {
      set({ loading: true });
      try {
        const tree = await api.tree();
        set({ folders: tree.folders, projects: tree.projects });
        const last = readLastProject();
        if (get().selectedProjectId === null && last !== null && tree.projects.some((p) => p.id === last)) {
          void get().selectProject(last);
        }
        void restoreTerminal();
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

    createProject: async (name, folderPath, folderId = null) => {
      try {
        const project = await api.createProject(name, folderPath, folderId);
        set((s) => ({ projects: [...s.projects, project] }));
        await get().selectProject(project.id);
        return true;
      } catch (e) {
        get().pushError(e);
        return false;
      }
    },

    linkProjectFolder: async (id, folderPath) => {
      try {
        const project = await api.updateProject(id, { folderPath });
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
        return true;
      } catch (e) {
        get().pushError(e);
        return false;
      }
    },

    renameProject: (id, name) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }),
        () => api.updateProject(id, { name }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    setProjectIcon: (id, icon, iconColor) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, icon, iconColor } : p)) }),
        () => api.updateProject(id, { icon, iconColor }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    setProjectTerminalChoice: (id, kind, model, effort) => {
      // Empty, because null reads as nothing saved.
      const pair = { model: model ?? '', effort: effort ?? '' };
      const choice = {
        aiService: kind,
        ...(kind === 'claude' ? { claudeModel: pair.model, claudeEffort: pair.effort } : { antigravityModel: pair.model, antigravityEffort: pair.effort }),
      };
      return optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...choice } : p)) }),
        () => api.updateProject(id, choice),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      );
    },

    setDisplayType: (id, displayType) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, displayType } : p)) }),
        () => api.updateProject(id, { displayType }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    setProjectTagline: (id, tagline) => {
      const value = tagline?.trim() || null;
      return optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, tagline: value } : p)) }),
        () => api.updateProject(id, { tagline: value }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      );
    },

    // Not optimistic (there's nothing to show until the server has the bytes); the
    // panel shows a spinner via uploadingImage, and errors become toasts.
    setProjectImage: async (id, file) => {
      set((s) => ({ uploadingImage: [...s.uploadingImage, id] }));
      try {
        const project = await api.setProjectImage(id, await preparePicture(file));
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
      } catch (e) {
        get().pushError(e);
      } finally {
        set((s) => ({ uploadingImage: s.uploadingImage.filter((x) => x !== id) }));
      }
    },

    removeProjectImage: (id) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, imageVersion: null } : p)) }),
        () => api.deleteProjectImage(id),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    moveProject: (id, folderId) =>
      optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, folderId } : p)) }),
        () => api.updateProject(id, { folderId }),
        (project, s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }),
      ),

    placeProject: async (id, folderId, beforeId) => {
      const { projects } = get();
      const moving = projects.find((p) => p.id === id);
      if (!moving || beforeId === id) return;
      const siblings = projects.filter((p) => p.folderId === folderId && p.id !== id).sort(bySortOrder);
      let index = beforeId === null ? siblings.length : siblings.findIndex((p) => p.id === beforeId);
      if (index < 0) index = siblings.length;
      siblings.splice(index, 0, moving);
      const ids = siblings.map((p) => p.id);
      const unchanged =
        moving.folderId === folderId &&
        ids.every((pid, i) => i === 0 || bySortOrder(projects.find((p) => p.id === ids[i - 1])!, projects.find((p) => p.id === pid)!) < 0);
      if (unchanged) return;
      const order = new Map(ids.map((pid, i) => [pid, i]));
      await optimistic(
        (s) => ({ projects: s.projects.map((p) => (order.has(p.id) ? { ...p, folderId, sortOrder: order.get(p.id)! } : p)) }),
        () => api.reorderProjects(folderId, ids),
        (server) => ({ projects: server }),
      );
    },

    deleteProject: async (id) => {
      topicCache.delete(id);
      if (get().selectedProjectId === id) set({ selectedProjectId: null, topics: [], openTopicId: null });
      await optimistic((s) => ({ projects: s.projects.filter((p) => p.id !== id) }), () => api.deleteProject(id));
    },

    selectProject: async (id) => {
      const t0 = performance.now();
      const log = (step: string) => console.debug(`[bishop:tab-switch] project ${id} ${step}: ${(performance.now() - t0).toFixed(1)} ms`);
      // Remember the topics of the project we are leaving. Coming back shows them at once, then the fetch below corrects them.
      // Without this the board empties first, so every card unmounts and mounts again: two full renders per switch.
      const leaving = get().selectedProjectId;
      if (leaving !== null && leaving !== id) {
        const left = get().topics;
        if (left.every((t) => t.id >= 0 && t.tasks.every((k) => k.id >= 0))) topicCache.set(leaving, left);
      }
      const cached = id === null ? undefined : topicCache.get(id);
      const editsBefore = edits;
      set({ selectedProjectId: id, topics: cached ?? [], activeTaskIds: [], openTopicId: null, editingTagline: false });
      log(cached ? 'state reset (cached topics)' : 'state reset');
      // Time until the browser has rendered and painted the reset state.
      requestAnimationFrame(() => setTimeout(() => log('first paint after reset'), 0));
      writeLastProject(id);
      if (id === null) return;
      api.categories(id).then((categories) => {
        log('categories fetched');
        set((s) => ({ categories: { ...s.categories, [id]: categories } }));
      }, get().pushError);
      try {
        const topics = await api.listTopics(id);
        log(`topics fetched (${topics.length})`);
        if (get().selectedProjectId === id) {
          topicCache.set(id, topics);
          // Same as the cached copy: keep it, so nothing re-renders.
          // An edit made on the cached board meanwhile wins: the 3 second refresh picks up the rest.
          if (edits === editsBefore && inFlight === 0 && JSON.stringify(topics) !== JSON.stringify(get().topics)) set({ topics });
          log('topics set');
          requestAnimationFrame(() => setTimeout(() => log('first paint after topics'), 0));
        } else {
          log('topics discarded (project changed)');
        }
      } catch (e) {
        get().pushError(e);
      }
    },

    // ----------------------------------------------------------- topics

    createTopic: async (title, category) => {
      const pid = projectId();
      const id = tempId--;
      const draft: Topic = { id, title, description: '', category, sortOrder: Number.MAX_SAFE_INTEGER, createdAt: now(), updatedAt: now(), archivedAt: null, sameSession: true, modelFamily: 'claude', modelOverride: null, effortOverride: null, tasks: [] };
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
        // Keep local tasks and archive state: they may have pending optimistic changes of their own.
        (topic, s) => ({ topics: s.topics.map((t) => (t.id === id ? { ...topic, tasks: t.tasks, archivedAt: t.archivedAt } : t)) }),
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

    setTopicArchived: async (id, archived) => {
      if (id < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({
          topics: s.topics.map((t) => (t.id === id ? { ...t, archivedAt: archived ? now() : null } : t)),
          openTopicId: archived && s.openTopicId === id ? null : s.openTopicId,
        }),
        () => api.updateTopic(pid, id, { archived }),
        (topic, s) => ({ topics: s.topics.map((t) => (t.id === id ? { ...topic, tasks: t.tasks } : t)) }),
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
      for (let i = 0; i < draft.tasks.length; i++) {
        const title = draft.tasks[i];
        const complexity = draft.taskComplexities?.[i] !== undefined ? clampComplexity(draft.taskComplexities[i]) : rateTaskComplexity(title);
        try {
          tasks.push(await api.addTask(pid, topic.id, title, draft.taskUserActions?.[i] === true, complexity));
        } catch {
          failed++;
        }
      }
      // A background refresh may have picked the new topic up already.
      if (get().selectedProjectId === pid) set((s) => ({ topics: [...s.topics.filter((t) => t.id !== topic.id), { ...topic, tasks }] }));
      if (failed) get().pushError(new Error(`Topic saved, but ${failed} task(s) couldn't be added.`));
      return true;
    },

    refineTopicWithAnswers: async (topicId, data) => {
      if (topicId < 0) return null;
      const pid = projectId();
      const currentTopic = get().topics.find((t) => t.id === topicId);
      if (!currentTopic) return null;

      try {
        const res = await api.refineTopic(pid, topicId, {
          title: currentTopic.title,
          description: currentTopic.description ?? '',
          category: currentTopic.category,
          tasks: currentTopic.tasks.map((t) => (t.completed ? `${t.title} (completed)` : t.title)),
          answers: data.answers,
          notes: data.notes,
          missing: data.missing,
        });

        if (res && res.topic) {
          set((s) => ({
            topics: s.topics.map((t) =>
              t.id === topicId
                ? {
                    ...t,
                    ...res.topic,
                    tasks: res.tasks,
                  }
                : t,
            ),
          }));
        }

        return res;
      } catch (e) {
        get().pushError(e);
        throw e;
      }
    },

    moveTopic: async (id, category, index) => {
      if (id < 0) return;
      const pid = projectId();
      const moving = get().topics.find((t) => t.id === id);
      if (!moving) return;
      const column = get().topics.filter((t) => t.category === category && t.id !== id && !t.archivedAt).sort(bySortOrder);
      column.splice(Math.max(0, Math.min(index, column.length)), 0, moving);
      const ids = column.map((t) => t.id).filter((tid) => tid > 0);
      const order = new Map(column.map((t, i) => [t.id, i]));
      await optimistic(
        (s) => ({ topics: s.topics.map((t) => (order.has(t.id) ? { ...t, category, sortOrder: order.get(t.id)! } : t)) }),
        () => api.reorderTopics(pid, category, ids),
        // Take category/order from the server but keep local tasks (they may have pending edits).
        (server, s) => {
          const byId = new Map(server.map((t) => [t.id, t]));
          return {
            topics: s.topics.map((t) => {
              const fresh = byId.get(t.id);
              return fresh ? { ...t, category: fresh.category, sortOrder: fresh.sortOrder } : t;
            }),
          };
        },
      );
    },

    setTopicDropProject: (id) => {
      if (get().topicDropProjectId !== id) set({ topicDropProjectId: id });
    },

    moveTopicToProject: async (id, toProjectId) => {
      const from = get().selectedProjectId;
      if (id < 0 || from === null || from === toProjectId) return;
      const moving = get().topics.find((t) => t.id === id);
      if (!moving) return;
      try {
        await api.moveTopic(from, id, { toProjectId });
      } catch (e) {
        get().pushError(e);
        return;
      }
      // The topic now lives in the other project. Drop it from this board right away.
      set((s) => (s.selectedProjectId === from ? { topics: s.topics.filter((t) => t.id !== id), openTopicId: s.openTopicId === id ? null : s.openTopicId } : {}));
      const dest = get().projects.find((p) => p.id === toProjectId);
      get().pushInfo(`Moved "${moving.title}" to ${dest?.name ?? 'the other project'}`);
      // Refresh both projects from the host. Only the open project's topics are cached, so the destination
      // loads fresh when it is opened; its categories are cached by project id and may have changed.
      const reload = async (pid: number) => {
        const [categories, topics] = await Promise.all([api.categories(pid), pid === from ? api.listTopics(pid) : Promise.resolve(null)]);
        set((s) => ({
          categories: { ...s.categories, [pid]: categories },
          ...(topics && s.selectedProjectId === pid ? { topics } : {}),
        }));
      };
      await Promise.all([reload(from), reload(toProjectId)]).catch((e) => get().pushError(e));
    },

    openTopic: (id) => set({ openTopicId: id }),

    // ------------------------------------------------------------ tasks

    addTask: async (topicId, title, prerequisite = false, complexity) => {
      if (topicId < 0) return; // topic not saved yet
      const pid = projectId();
      const id = tempId--;
      const rated = clampComplexity(complexity ?? rateTaskComplexity(title));
      const draft: Task = { id, topicId, title, completed: false, sortOrder: Number.MAX_SAFE_INTEGER, createdAt: now(), completedAt: null, queued: false, queuedAt: null, prerequisite, followUp: false, complexity: rated, reply: null };
      await optimistic(
        (s) => ({ topics: s.topics.map((t) => (t.id === topicId ? { ...t, tasks: [...t.tasks, draft] } : t)) }),
        () => api.addTask(pid, topicId, title, prerequisite, rated),
        (task, s) => ({ topics: mapTask(s.topics, id, () => task) }),
      );
    },

    addCategoryTask: async (category, categoryName, title) => {
      const pid = projectId();
      let topic = [...get().topics].sort(bySortOrder).find((t) => t.category === category && !t.archivedAt && t.id >= 0);
      if (!topic) {
        try {
          const created = await api.createTopic(pid, { title: categoryName, category });
          set((s) => ({ topics: [...s.topics, created] }));
          topic = created;
        } catch (e) {
          get().pushError(e);
          return;
        }
      }
      // Personal tasks start at the default severity instead of a keyword rating.
      const start = SEVERITIES.find((s) => s.key === DEFAULT_SEVERITY)!.complexity;
      await get().addTask(topic.id, title, false, start);
    },

    setTaskCompleted: async (taskId, completed) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, completed, completedAt: completed ? now() : null, queued: completed ? false : t.queued, queuedAt: completed ? null : t.queuedAt })) }),
        () => api.completeTask(pid, taskId, completed),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    setTaskQueued: async (taskId, queued) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, queued, queuedAt: !queued ? null : t.queued ? t.queuedAt : now() })) }),
        () => api.updateTask(pid, taskId, { queued }),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
      // The sidebar shows the queue count, so don't wait for the next refresh.
      void get().refreshSessions();
    },

    setTaskPrerequisite: async (taskId, prerequisite) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, prerequisite, followUp: prerequisite ? t.followUp : false })) }),
        () => api.updateTask(pid, taskId, { prerequisite }),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    setTaskFollowUp: async (taskId, followUp) => {
      if (taskId < 0) return;
      const pid = projectId();
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, followUp })) }),
        () => api.updateTask(pid, taskId, { followUp }),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    setTaskReply: async (taskId, reply) => {
      if (taskId < 0) return;
      const pid = projectId();
      const text = reply.trim() === '' ? null : reply;
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, reply: text })) }),
        () => api.updateTask(pid, taskId, { reply: text }),
        (task, s) => ({ topics: mapTask(s.topics, taskId, () => task) }),
      );
    },

    setTaskComplexity: async (taskId, complexity) => {
      if (taskId < 0) return;
      const pid = projectId();
      const rated = clampComplexity(complexity);
      await optimistic(
        (s) => ({ topics: mapTask(s.topics, taskId, (t) => ({ ...t, complexity: rated })) }),
        () => api.updateTask(pid, taskId, { complexity: rated }),
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

    reorderTasks: async (topicId, orderedIds) => {
      if (topicId < 0) return;
      const pid = projectId();
      const order = new Map(orderedIds.map((tid, i) => [tid, i]));
      await optimistic(
        (s) => ({
          topics: s.topics.map((t) =>
            t.id === topicId ? { ...t, tasks: t.tasks.map((k) => (order.has(k.id) ? { ...k, sortOrder: order.get(k.id)! } : k)) } : t,
          ),
        }),
        () => api.reorderTasks(pid, topicId, orderedIds.filter((tid) => tid > 0)),
      );
    },

    moveTaskToCategory: async (taskId, category, categoryName, index) => {
      if (taskId < 0) return;
      const pid = projectId();
      let target = [...get().topics].sort(bySortOrder).find((t) => t.category === category && !t.archivedAt && t.id >= 0);
      if (!target) {
        try {
          const created = await api.createTopic(pid, { title: categoryName, category });
          set((s) => ({ topics: [...s.topics, created] }));
          target = created;
        } catch (e) {
          get().pushError(e);
          return;
        }
      }
      const targetId = target.id;
      const task = get().topics.flatMap((t) => t.tasks).find((k) => k.id === taskId);
      if (!task || task.topicId === targetId) return;
      await optimistic(
        (s) => ({
          topics: s.topics.map((t) => {
            if (t.id === task.topicId) {
              return { ...t, tasks: t.tasks.filter((k) => k.id !== taskId).sort(bySortOrder).map((k, i) => ({ ...k, sortOrder: i })) };
            }
            if (t.id !== targetId) return t;
            const ordered = [...t.tasks].sort(bySortOrder);
            ordered.splice(index === null ? ordered.length : Math.min(index, ordered.length), 0, { ...task, topicId: targetId });
            return { ...t, tasks: ordered.map((k, i) => ({ ...k, sortOrder: i })) };
          }),
        }),
        () => api.moveTask(pid, taskId, targetId, index),
      );
    },

    // ----------------------------------------------------------- dialogs

    confirm: ({ title, message, confirmLabel = 'Delete' }) =>
      new Promise<boolean>((resolve) => {
        get().confirmRequest?.resolve(false);
        set({
          confirmRequest: {
            title,
            message,
            confirmLabel,
            resolve: (ok) => {
              set({ confirmRequest: null });
              resolve(ok);
            },
          },
        });
      }),

    // ----------------------------------------------------------- toasts

    pushError: (e) => {
      const id = toastId++;
      set((s) => ({ toasts: [...s.toasts, { id, message: message(e), kind: 'error' }] }));
      setTimeout(() => get().dismissToast(id), 5000);
    },

    pushInfo: (text) => {
      const id = toastId++;
      set((s) => ({ toasts: [...s.toasts, { id, message: text, kind: 'info' }] }));
      setTimeout(() => get().dismissToast(id), 4000);
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
