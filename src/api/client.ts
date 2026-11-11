import { clampComplexity, rateTaskComplexity, type AgentsFile, type AiService, type AntigravityUsage, type TerminalInfo, type TerminalKind, type TerminalModel, type BackupInfo, type DelegationConfig, type Category, type ClaudeUsage, type Folder, type FolderStatus, type ModelFamily, type Project, type ProjectCategory, type DisplayType, type QueuedCount, type RefinedTopicResponse, type SearchHit, type SessionRecord, type Task, type TaskMetric, type Topic, type TopicContextFile, type TopicDraft, type TopicMove, type TopicResearch, type Transcription, type Tree, type VoiceStatus } from '../types';
import { logClient } from './log';

const TASK_COMPLEXITY_KEY = 'bishop_task_complexity';

/** User tasks a Voice topic keeps: art or audio assets, and open decisions. Other drafted user tasks, such as testing, are dropped. */
const ART_TASK = /\b(art|artwork|assets?|sprites?|icons?|illustrations?|drawings?|draw|paint|textures?|logos?|images?|3d models?|audio|sound|music|voiceovers?|voice-overs?|voice lines?|record audio|record voice)\b/i;
const DECISION_TASK = /\b(decide|decides|decision|decisions|choose|choice|pick|which one|unclear|clarify|naming)\b/i;

/** Agent tasks always stay. A user task stays only when its title is art or an open decision. */
function keepDraftTask(title: string, userAction: boolean): boolean {
  return !userAction || ART_TASK.test(title) || DECISION_TASK.test(title);
}

function readComplexityCache(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TASK_COMPLEXITY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeCachedComplexity(projectId: number, taskId: number, complexity: number) {
  try {
    const map = readComplexityCache();
    map[`${projectId}:${taskId}`] = clampComplexity(complexity);
    localStorage.setItem(TASK_COMPLEXITY_KEY, JSON.stringify(map));
  } catch {}
}

function normalizeTask(projectId: number, task: Task, fallbackComplexity?: number): Task {
  if (typeof task.complexity === 'number' && Number.isFinite(task.complexity)) {
    return { ...task, followUp: task.followUp === true, complexity: clampComplexity(task.complexity) };
  }
  const cached = readComplexityCache()[`${projectId}:${task.id}`];
  const complexity = clampComplexity(fallbackComplexity ?? cached ?? rateTaskComplexity(task.title));
  if (fallbackComplexity !== undefined && task.id > 0) {
    writeCachedComplexity(projectId, task.id, complexity);
  }
  return { ...task, followUp: task.followUp === true, complexity };
}

function normalizeTopic(projectId: number, topic: Topic): Topic {
  return {
    ...topic,
    modelFamily: topic.modelFamily === 'gemini' ? 'gemini' : 'claude',
    modelOverride: topic.modelOverride ?? null,
    effortOverride: topic.effortOverride ?? null,
    tasks: (topic.tasks ?? []).map((t) => normalizeTask(projectId, t)),
  };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isBlob = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': isBlob ? body.type || 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
    });
  } catch {
    logClient('warn', `${method} ${path}: can't reach the local server`);
    throw new ApiError(0, "Can't reach Bishop's local server.");
  }
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const data = await res.json();
      message = data.error ?? message;
      code = data.code ?? undefined;
    } catch {}
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  tree: () => request<Tree>('GET', '/tree'),
  queuedTasks: () => request<QueuedCount[]>('GET', '/queued-tasks'),
  taskMetrics: () => request<TaskMetric[]>('GET', '/task-metrics'),

  createFolder: (name: string, parentId: number | null = null) =>
    request<Folder>('POST', '/folders', { name, parentId }),
  updateFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
    request<Folder>('PATCH', `/folders/${id}`, patch),
  deleteFolder: (id: number) => request<void>('DELETE', `/folders/${id}`),

  createProject: (name: string, folderPath: string, folderId: number | null = null, displayType?: DisplayType) =>
    request<Project>('POST', '/projects', { name, folderPath, folderId, displayType }),
  updateProject: (
    id: number,
    patch: {
      name?: string;
      folderId?: number | null;
      tagline?: string | null;
      folderPath?: string;
      icon?: string | null;
      iconColor?: string | null;
      claudeModel?: string | null;
      claudeEffort?: string | null;
      antigravityModel?: string | null;
      antigravityEffort?: string | null;
      aiService?: AiService | null;
      displayType?: DisplayType;
    },
  ) => request<Project>('PATCH', `/projects/${id}`, patch),
  deleteProject: (id: number) => request<void>('DELETE', `/projects/${id}`),
  projectImageUrl: (id: number, version: string) => `/api/projects/${id}/image?v=${encodeURIComponent(version)}`,
  setProjectImage: (id: number, image: Blob) => request<Project>('POST', `/projects/${id}/image`, image),
  deleteProjectImage: (id: number) => request<Project>('DELETE', `/projects/${id}/image`),
  reorderProjects: (folderId: number | null, projectIds: number[]) =>
    request<Project[]>('POST', '/projects/reorder', { folderId, projectIds }),

  categories: (projectId: number) => request<ProjectCategory[]>('GET', `/projects/${projectId}/categories`),
  addCategory: (projectId: number, name: string) => request<ProjectCategory[]>('POST', `/projects/${projectId}/categories`, { name }),
  renameCategory: (projectId: number, category: Category, name: string) =>
    request<ProjectCategory[]>('PATCH', `/projects/${projectId}/categories/${category}`, { name }),
  /** `moveTo` takes the category's topics. It can only be left out when the category has none. */
  removeCategory: (projectId: number, category: Category, moveTo: Category | null) =>
    request<{ categories: ProjectCategory[]; topics: Topic[] }>(
      'DELETE',
      `/projects/${projectId}/categories/${category}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`,
    ).then((r) => ({ ...r, topics: r.topics.map((t) => normalizeTopic(projectId, t)) })),

  listTopics: (projectId: number) =>
    request<Topic[]>('GET', `/projects/${projectId}/topics`).then((list) => list.map((t) => normalizeTopic(projectId, t))),
  createTopic: (projectId: number, topic: { title: string; description?: string; category?: Category }) =>
    request<Topic>('POST', `/projects/${projectId}/topics`, topic).then((t) => normalizeTopic(projectId, t)),
  updateTopic: (
    projectId: number,
    topicId: number,
    patch: { title?: string; description?: string; category?: Category; sortOrder?: number; archived?: boolean; sameSession?: boolean; modelFamily?: ModelFamily; modelOverride?: string | null; effortOverride?: string | null },
  ) => request<Topic>('PATCH', `/projects/${projectId}/topics/${topicId}`, patch).then((t) => normalizeTopic(projectId, t)),
  reorderTopics: (projectId: number, category: Category, topicIds: number[]) =>
    request<Topic[]>('POST', `/projects/${projectId}/topics/reorder`, { category, topicIds }).then((list) =>
      list.map((t) => normalizeTopic(projectId, t)),
    ),
  /** Moves a topic and its tasks to another project. Returns the topic as it is there, with new ids. Throws ApiError code `same_project` for the topic's own project. */
  moveTopic: (projectId: number, topicId: number, move: TopicMove) =>
    request<Topic>('POST', `/projects/${projectId}/topics/${topicId}/move`, move).then((t) => normalizeTopic(move.toProjectId, t)),
  deleteTopic: (projectId: number, topicId: number) =>
    request<void>('DELETE', `/projects/${projectId}/topics/${topicId}`),
  getTopicContext: (projectId: number, topicId: number) =>
    request<TopicContextFile>('GET', `/projects/${projectId}/topics/${topicId}/context`),

  listTasks: (projectId: number, topicId: number) =>
    request<Task[]>('GET', `/projects/${projectId}/topics/${topicId}/tasks`).then((list) => list.map((t) => normalizeTask(projectId, t))),
  listPrerequisites: (projectId: number, topicId: number) =>
    request<Task[]>('GET', `/projects/${projectId}/topics/${topicId}/prerequisites`).then((list) =>
      list.map((t) => normalizeTask(projectId, t)),
    ),
  addTask: (projectId: number, topicId: number, title: string, prerequisite = false, complexity?: number) => {
    const rated = clampComplexity(complexity ?? rateTaskComplexity(title));
    return request<Task>('POST', `/projects/${projectId}/topics/${topicId}/tasks`, { title, prerequisite, complexity: rated }).then((t) =>
      normalizeTask(projectId, t, rated),
    );
  },
  updateTask: (
    projectId: number,
    taskId: number,
    patch: { title?: string; completed?: boolean; sortOrder?: number; queued?: boolean; prerequisite?: boolean; followUp?: boolean; complexity?: number; reply?: string | null },
  ) => {
    if (patch.complexity !== undefined) writeCachedComplexity(projectId, taskId, patch.complexity);
    return request<Task>('PATCH', `/projects/${projectId}/tasks/${taskId}`, patch).then((t) =>
      normalizeTask(projectId, t, patch.complexity),
    );
  },
  completeTask: (projectId: number, taskId: number, completed = true) =>
    request<Task>('PATCH', `/projects/${projectId}/tasks/${taskId}`, { completed }).then((t) => normalizeTask(projectId, t)),
  moveTask: (projectId: number, taskId: number, topicId: number, index: number | null) =>
    request<Task[]>('POST', `/projects/${projectId}/tasks/${taskId}/move`, { topicId, index }).then((list) =>
      list.map((t) => normalizeTask(projectId, t)),
    ),
  reorderTasks: (projectId: number, topicId: number, taskIds: number[]) =>
    request<Task[]>('POST', `/projects/${projectId}/topics/${topicId}/tasks/reorder`, { taskIds }).then((list) =>
      list.map((t) => normalizeTask(projectId, t)),
    ),
  deleteTask: (projectId: number, taskId: number) =>
    request<void>('DELETE', `/projects/${projectId}/tasks/${taskId}`),

  suggestFolder: (name: string) => request<{ root: string; path: string }>('GET', `/project-folders/suggest?name=${encodeURIComponent(name)}`),
  folderStatus: (path: string) => request<FolderStatus>('GET', `/project-folders/status?path=${encodeURIComponent(path)}`),
  pickFolder: (initial?: string, title?: string) => request<{ path: string | null }>('POST', '/system/pick-folder', { initial, title }),
  openProjectFolder: (id: number) => request<{ ok: boolean }>('POST', `/projects/${id}/open-folder`),
  getAgents: (id: number) => request<AgentsFile>('GET', `/projects/${id}/agents`),
  saveAgents: (id: number, content: string, baseHash: string, force = false) =>
    request<AgentsFile>('PUT', `/projects/${id}/agents`, { content, baseHash, force }),

  /** Leave out `projectId` for the sessions of every project. */
  listTerminals: (projectId?: number) =>
    request<TerminalInfo[]>('GET', projectId === undefined ? '/terminal/sessions' : `/terminal/sessions?projectId=${projectId}`),
  /** The models this CLI offers. Empty if the CLI couldn't list them. */
  terminalModels: (kind: TerminalKind) => request<TerminalModel[]>('GET', `/terminal/models?kind=${kind}`),
  /** taskId starts Claude or Antigravity on that task, with a brief about its topic. A null model or effort leaves the choice to the CLI. */
  startTerminal: (projectId: number, kind: TerminalKind, cols: number, rows: number, taskId?: number, model?: string | null, effort?: string | null) =>
    request<TerminalInfo>('POST', '/terminal/sessions', { projectId, kind, cols, rows, taskId, model, effort }),
  /** False: Antigravity would open its trust dialog in this project's folder, and a task would run behind it. */
  antigravityTrust: (projectId: number) => request<{ trusted: boolean }>('GET', `/terminal/antigravity-trust?projectId=${projectId}`),
  /** Only after the user agreed: saves what answering yes in Antigravity's trust dialog saves. */
  trustAntigravityFolder: (projectId: number) => request<void>('POST', '/terminal/antigravity-trust', { projectId }),
  /** Brings a session back as its project's session; an ended one shows its scrollback. The one it replaces moves to the background. */
  /** Saved sessions of a project whose last activity was in the past `days` days (default 7), most recent first. */
  listRecentSessions: (projectId: number, days?: number) =>
    request<SessionRecord[]>('GET', days === undefined ? `/projects/${projectId}/sessions` : `/projects/${projectId}/sessions?days=${days}`),
  reopenTerminal: (id: string) => request<TerminalInfo>('POST', `/terminal/sessions/${id}/reopen`),
  /** Ends a session. A used one stays listed, as ended. */
  closeTerminal: (id: string) => request<void>('DELETE', `/terminal/sessions/${id}`),

  search: (q: string) => request<SearchHit[]>('GET', `/search?q=${encodeURIComponent(q)}`),

  listBackups: () => request<{ folder: string; keep: number; backups: BackupInfo[] }>('GET', '/backups'),
  backupNow: () => request<BackupInfo>('POST', '/backups'),
  openBackupsFolder: () => request<{ ok: boolean }>('POST', '/backups/open'),

  setBackgroundModel: (model: string | null, effort: string | null, service: AiService = 'claude') =>
    request<{ ok: boolean }>('PUT', '/claude/background-model', { model, effort, service }),
  setSilentMode: (on: boolean) => request<{ ok: boolean }>('PUT', '/settings/silent-mode', { on }),
  delegationConfig: () => request<DelegationConfig>('GET', '/settings/delegation'),
  saveDelegationConfig: (config: DelegationConfig) => request<DelegationConfig>('PUT', '/settings/delegation', config),
  claudeUsage: () => request<ClaudeUsage>('GET', '/claude/usage'),
  antigravityUsage: () => request<AntigravityUsage>('GET', '/antigravity/usage'),
  voiceStatus: () => request<VoiceStatus>('GET', '/voice/status'),
  downloadModel: () => request<VoiceStatus>('POST', '/voice/model/download'),
  transcribe: (wav: Blob) => request<Transcription>('POST', '/transcribe', wav),
  topicFromTranscript: (projectId: number, transcript: string) =>
    request<TopicDraft[]>('POST', `/projects/${projectId}/topic-from-transcript`, { transcript }).then((drafts) =>
      drafts.map((d) => {
        const kept = d.tasks.flatMap((title, i) => {
          const userAction = d.taskUserActions?.[i] === true;
          if (!keepDraftTask(title, userAction)) return [];
          const complexity =
            typeof d.taskComplexities?.[i] === 'number' && Number.isFinite(d.taskComplexities[i])
              ? clampComplexity(d.taskComplexities[i])
              : rateTaskComplexity(title);
          return [{ title, complexity, userAction }];
        });
        return {
          ...d,
          tasks: kept.map((k) => k.title),
          taskComplexities: kept.map((k) => k.complexity),
          taskUserActions: kept.map((k) => k.userAction),
        };
      }),
    ),
  researchTopic: (projectId: number, draft: TopicDraft) =>
    request<TopicResearch>('POST', `/projects/${projectId}/topic-research`, draft),
  reviewTopic: async (
    projectId: number,
    topicId: number,
    draft?: Partial<TopicDraft> & { answers?: string[]; notes?: string },
  ) => {
    try {
      return await request<TopicResearch>('POST', `/projects/${projectId}/topics/${topicId}/review`, draft ?? {});
    } catch {
      return await request<TopicResearch>('POST', `/projects/${projectId}/topic-research`, {
        ...draft,
        topicId,
      });
    }
  },
  refineTopic: async (
    projectId: number,
    topicId: number,
    data: {
      title?: string;
      description?: string;
      category?: Category;
      tasks?: string[];
      answers?: string[];
      notes?: string;
      missing?: string[];
    },
  ): Promise<RefinedTopicResponse> => {
    try {
      const res = await request<RefinedTopicResponse>('POST', `/projects/${projectId}/topics/${topicId}/refine`, data);
      return {
        ...res,
        topic: normalizeTopic(projectId, res.topic),
        tasks: (res.tasks ?? []).map((t) => normalizeTask(projectId, t)),
        addedTasks: (res.addedTasks ?? []).map((t) => normalizeTask(projectId, t)),
      };
    } catch {
      // Fallback for older running hosts without /refine endpoint
      const currentTasks = await request<Task[]>('GET', `/projects/${projectId}/topics/${topicId}/tasks`).catch(() => []);
      const existingDesc = data.description ?? '';
      const notesAndAnswers: string[] = [];
      if (data.answers && data.answers.length > 0) {
        notesAndAnswers.push(...data.answers);
      }
      if (data.notes && data.notes.trim().length > 0) {
        notesAndAnswers.push(data.notes.trim());
      }

      let updatedDescription = existingDesc;
      if (notesAndAnswers.length > 0) {
        const addition = '\n\nAnswers:\n' + notesAndAnswers.map((a) => `- ${a}`).join('\n');
        updatedDescription = existingDesc ? `${existingDesc}${addition}` : notesAndAnswers.map((a) => `- ${a}`).join('\n');
      }

      const updatedTopic = await request<Topic>('PATCH', `/projects/${projectId}/topics/${topicId}`, {
        description: updatedDescription,
        title: data.title,
      });

      const existingSet = new Set(currentTasks.map((t) => t.title.trim().toLowerCase()));
      const addedTasks: Task[] = [];
      if (data.missing && data.missing.length > 0) {
        for (const missingTitle of data.missing) {
          const trimmed = missingTitle.trim();
          if (trimmed && !existingSet.has(trimmed.toLowerCase())) {
            try {
              const rated = rateTaskComplexity(trimmed);
              const added = await request<Task>('POST', `/projects/${projectId}/topics/${topicId}/tasks`, { title: trimmed, complexity: rated });
              addedTasks.push(normalizeTask(projectId, added, rated));
              existingSet.add(trimmed.toLowerCase());
            } catch {
              // ignore
            }
          }
        }
      }

      const allTasks = await request<Task[]>('GET', `/projects/${projectId}/topics/${topicId}/tasks`).catch(() => [
        ...currentTasks,
        ...addedTasks,
      ]);

      return {
        topic: normalizeTopic(projectId, updatedTopic),
        tasks: allTasks.map((t) => normalizeTask(projectId, t)),
        addedTasks,
        newTasksCount: addedTasks.length,
        userActions: [],
        prerequisites: [],
      };
    }
  },
};

// Frameless window controls; harmless no-ops in the browser dev server.
type WindowResult = { ok: boolean; isMaximized?: boolean };
const win = (action: string, body: object = {}): Promise<WindowResult> =>
  request<WindowResult>('POST', `/window/${action}`, body).catch(() => ({ ok: false }));

export const windowApi = {
  drag: () => win('drag'),
  resize: (dir: string) => win('resize', { dir }),
  minimize: () => win('minimize'),
  maximize: () => win('maximize'),
  close: () =>
    win('close').then((r) => {
      if (!r.ok) window.close();
    }),
};
