import type { Category, Folder, Project, Task, Topic, Tree } from '../types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach Bishop's local server.");
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  tree: () => request<Tree>('GET', '/tree'),

  createFolder: (name: string, parentId: number | null = null) =>
    request<Folder>('POST', '/folders', { name, parentId }),
  updateFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
    request<Folder>('PATCH', `/folders/${id}`, patch),
  deleteFolder: (id: number) => request<void>('DELETE', `/folders/${id}`),

  createProject: (name: string, folderId: number | null = null) =>
    request<Project>('POST', '/projects', { name, folderId }),
  updateProject: (id: number, patch: { name?: string; folderId?: number | null }) =>
    request<Project>('PATCH', `/projects/${id}`, patch),
  deleteProject: (id: number) => request<void>('DELETE', `/projects/${id}`),

  listTopics: (projectId: number) => request<Topic[]>('GET', `/projects/${projectId}/topics`),
  createTopic: (projectId: number, topic: { title: string; description?: string; category?: Category }) =>
    request<Topic>('POST', `/projects/${projectId}/topics`, topic),
  updateTopic: (
    projectId: number,
    topicId: number,
    patch: { title?: string; description?: string; category?: Category; sortOrder?: number },
  ) => request<Topic>('PATCH', `/projects/${projectId}/topics/${topicId}`, patch),
  deleteTopic: (projectId: number, topicId: number) =>
    request<void>('DELETE', `/projects/${projectId}/topics/${topicId}`),

  listTasks: (projectId: number, topicId: number) =>
    request<Task[]>('GET', `/projects/${projectId}/topics/${topicId}/tasks`),
  addTask: (projectId: number, topicId: number, title: string) =>
    request<Task>('POST', `/projects/${projectId}/topics/${topicId}/tasks`, { title }),
  updateTask: (projectId: number, taskId: number, patch: { title?: string; completed?: boolean; sortOrder?: number }) =>
    request<Task>('PATCH', `/projects/${projectId}/tasks/${taskId}`, patch),
  completeTask: (projectId: number, taskId: number, completed = true) =>
    request<Task>('PATCH', `/projects/${projectId}/tasks/${taskId}`, { completed }),
  deleteTask: (projectId: number, taskId: number) =>
    request<void>('DELETE', `/projects/${projectId}/tasks/${taskId}`),
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
