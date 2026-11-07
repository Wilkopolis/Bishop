/** The key of one of a project's categories, as stored on its topics. */
export type Category = string;

/** One section of a project's board. Each project has its own list, in board order. */
export interface ProjectCategory {
  key: Category;
  name: string;
}

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
  /** Set when the project has a picture; changes whenever the picture does (cache key). */
  imageVersion: string | null;
  /** Icon id from the project icon catalog. Null means the default notebook. */
  icon: string | null;
  /** Icon tint as #rrggbb. Null means the normal text color. */
  iconColor: string | null;
  /** The project's working folder on disk (holds AGENTS.md). Null for projects created before folders existed. */
  folderPath: string | null;
  /** folderPath is set but the folder no longer exists. */
  folderMissing: boolean;
  /** The model and reasoning level saved on this project, per CLI. Null: nothing saved. Empty: the CLI's own default. */
  claudeModel: string | null;
  claudeEffort: string | null;
  antigravityModel: string | null;
  antigravityEffort: string | null;
  /** The AI service saved on this project. Null: nothing saved, so it follows the last one chosen. */
  aiService: AiService | null;
  /** agent: the full layout. personal: only categories and simple tasks. */
  projectType: ProjectType;
}

export type ProjectType = 'agent' | 'personal';
export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = { agent: 'Agent', personal: 'Personal' };

export interface FolderStatus {
  path: string;
  exists: boolean;
  hasAgents: boolean;
  isFile: boolean;
}

export type TerminalKind = 'claude' | 'antigravity' | 'shell';

/** The CLIs that can work on a project. PowerShell isn't one. */
export type AiService = Exclude<TerminalKind, 'shell'>;

export const AI_SERVICE_LABELS: Record<AiService, string> = { claude: 'Claude', antigravity: 'Antigravity' };
export const AI_SERVICES = Object.keys(AI_SERVICE_LABELS) as AiService[];
export const DEFAULT_MODEL = 'Default model';
export const DEFAULT_EFFORT = 'Default reasoning';
export const effortLabel = (e: string) => ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[e] ?? e;
/** The levels a model takes. With no model chosen the CLI picks one, so any level on the list may fit. */
export const levelsOf = (list: TerminalModel[], id: string | null) => list.find((m) => m.id === id)?.efforts ?? [...new Set(list.flatMap((m) => m.efforts))];

export interface TerminalInfo {
  id: string;
  projectId: number;
  kind: TerminalKind;
  title: string;
  cwd: string;
  alive: boolean;
  exitCode: number | null;
  /** False until someone types in the session. Sessions started on a task always count as used. */
  used: boolean;
  /** The topic of the session's latest task. Null for a plain session. */
  topicId: number | null;
  /** The session's latest task. Null for a plain session. In same session mode a session takes on one task after another. */
  taskId: number | null;
  taskTitle: string | null;
  /** Claude is still on its task: the session is alive and Claude hasn't reported the task as done. */
  taskRunning: boolean;
  /** When Claude reported the task as done. Null until then. */
  taskFinishedAt: string | null;
  /**
   * The session runs on out of view, and the Terminal lets go of it and never stops it. Claude reporting its task
   * as done puts it here, and so does reopening another session of the project. Reopening it brings it back.
   * Closing a used session puts it here too: it has ended, and stays listed for the session feed.
   */
  background: boolean;
  /** When the process ended. Null while it runs. An ended session keeps its scrollback until the app closes. */
  endedAt: string | null;
  /** The model the CLI was started on. Null: the CLI's own default. */
  model: string | null;
  /** The reasoning level the CLI was started on. Null: the CLI's own default. */
  effort: string | null;
  /** When the session last printed output, got typing or input, took a task or ended. Starts at the session's start. */
  lastActivityAt: string;
}

/** A saved Terminal session, from `GET /projects/{pid}/sessions`. Times are UTC ISO strings. */
export interface SessionRecord {
  id: string;
  kind: TerminalKind;
  title: string;
  topicId: number | null;
  taskId: number | null;
  taskTitle: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string;
  lastActivityAt: string;
  /** Null while the session may still be running. */
  endedAt: string | null;
}

/** A model the Terminal can start a CLI on. */
export interface TerminalModel {
  id: string;
  label: string;
  /** The reasoning levels this model takes, lowest first. */
  efforts: string[];
}

export interface AgentsFile {
  path: string;
  exists: boolean;
  content: string;
  /** Hash of the file as loaded; sent back on save to detect changes made outside Bishop. */
  hash: string;
}

export const MAX_TAGLINE_LENGTH = 200;
export const MAX_CATEGORY_NAME_LENGTH = 40;

export interface Task {
  id: number;
  topicId: number;
  title: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
  completedAt: string | null;
  /** Waiting its turn. Only open tasks can be queued; completing a task clears this. */
  queued: boolean;
  /** When the task was queued (ISO time), or null if it isn't. Orders queued topics in the Active section. */
  queuedAt: string | null;
  /** Work requiring user action that must be done before other tasks can proceed. */
  prerequisite: boolean;
  /** A user task done after the agent tasks instead of before them. Only set when `prerequisite` is true. */
  followUp: boolean;
  /** Complexity rating from 1 (simple) to 10 (very complex). */
  complexity: number;
  /** Written answer a user types on a user task. null means no reply yet. */
  reply: string | null;
}

export const clampComplexity = (n: number): number => Math.max(1, Math.min(10, Math.round(n)));

export const COMPLEXITY_COLORS: Record<number, string> = {
  1: '#10b981',
  2: '#22c55e',
  3: '#84cc16',
  4: '#eab308',
  5: '#f59e0b',
  6: '#fb923c',
  7: '#f97316',
  8: '#ef4444',
  9: '#e11d48',
  10: '#be123c',
};

/** CSS color for a task's 1 to 10 complexity rating. */
export function complexityColor(complexity: number): string {
  const c = clampComplexity(complexity);
  return `var(--complexity-${c}, ${COMPLEXITY_COLORS[c]})`;
}

/** Readable text color on top of `complexityColor(complexity)`. */
export function complexityTextColor(complexity: number): string {
  const c = clampComplexity(complexity);
  return c >= 2 && c <= 6 ? '#1c1917' : '#ffffff';
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Severity levels for personal project tasks. They are kept in the task's complexity rating, so no extra column is needed. */
export const SEVERITIES: { key: Severity; label: string; complexity: number }[] = [
  { key: 'low', label: 'Low', complexity: 2 },
  { key: 'medium', label: 'Medium', complexity: 5 },
  { key: 'high', label: 'High', complexity: 7 },
  { key: 'critical', label: 'Critical', complexity: 9 },
];
export const DEFAULT_SEVERITY: Severity = 'medium';

/** The severity a 1 to 10 complexity rating falls in: 1-3 Low, 4-6 Medium, 7-8 High, 9-10 Critical. */
export function severityOf(complexity: number): Severity {
  const c = clampComplexity(complexity);
  return c <= 3 ? 'low' : c <= 6 ? 'medium' : c <= 8 ? 'high' : 'critical';
}

/** Rates a task's complexity from 1 to 10 when Claude didn't supply a number. */
export function rateTaskComplexity(title: string): number {
  const text = (title ?? '').trim().toLowerCase();
  if (!text) return 3;

  let score = 4;

  const trivial = ['rename', 'typo', 'copy', 'label', 'tooltip', 'placeholder', 'padding', 'margin', 'align', 'center', 'spacing', 'border', 'pixel', 'px', 'font', 'tint', 'remove button', 'remove the', 'hide '];
  const simple = ['button', 'dropdown', 'badge', 'indicator', 'dot', 'checkbox', 'input', 'header', 'footer', 'color', 'icon', 'show ', 'display ', 'exclude', 'filter', 'sort'];
  const moderate = ['endpoint', 'api', 'store', 'state', 'persist', 'save', 'load', 'fetch', 'context', 'validation', 'map ', 'mapping', 'setting', 'family', 'delegate', 'delegating', 'choose', 'automatically', 'import', 'export', 'search', 'queue', 'modal', 'dialog'];
  const complex = ['schema', 'migration', 'database', 'sqlite', 'trigger', 'backfill', 'websocket', 'terminal', 'session', 'conpty', 'pty', 'whisper', 'transcribe', 'stream', 'concurrent', 'synchroniz', 'drag and drop', 'reorder', 'refactor', 'architecture', 'integration', 'security', 'algorithm', 'parse'];
  const veryComplex = ['end-to-end', 'distributed', 'engine', 'full-text', 'real-time', 'multi-agent', 'orchestrat', 'overhaul', 'rewrite'];

  if (trivial.some((w) => text.includes(w))) score -= 2;
  if (simple.some((w) => text.includes(w))) score = Math.max(score, 3);
  const modHits = moderate.filter((w) => text.includes(w)).length;
  if (modHits > 0) score = Math.max(score, 5) + Math.min(1, modHits - 1);
  const compHits = complex.filter((w) => text.includes(w)).length;
  if (compHits > 0) score = Math.max(score, 7) + Math.min(2, compHits - 1);
  if (veryComplex.some((w) => text.includes(w))) score = Math.max(score, 9);

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 4 && compHits === 0 && modHits === 0) score = Math.min(score, 3);
  else if (words >= 12) score += 1;

  return clampComplexity(score);
}

export type ModelFamily = 'claude' | 'gemini';

export const MODEL_FAMILIES: { value: ModelFamily; label: string; title: string }[] = [
  { value: 'claude', label: 'Claude', title: 'Delegate this topic\'s tasks to Claude models' },
  { value: 'gemini', label: 'Gemini', title: 'Delegate this topic\'s tasks to Gemini models in Antigravity' },
];

export interface Topic {
  id: number;
  title: string;
  description: string;
  category: Category;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Set while the topic is archived: hidden from the board, listed under Archived. */
  archivedAt: string | null;
  /** Tasks share one Claude session. False means each task starts a new session. */
  sameSession: boolean;
  /** Family of agent models this topic's tasks are delegated to. */
  modelFamily: ModelFamily;
  /** Model id picked for this topic. Null means tasks are delegated automatically. */
  modelOverride: string | null;
  /** Reasoning effort picked for this topic. Null means the CLI default or the automatic pick. */
  effortOverride: string | null;
  tasks: Task[];
}

/** Body of the move call. The topic goes to `toProjectId` with its tasks and gets new ids there. */
export interface TopicMove {
  toProjectId: number;
  /** The category in the destination. Left out: the topic keeps its category if the destination has it, else takes the destination's last one. */
  category?: Category;
}

/** Markdown file holding Claude's summaries of the finished tasks in a topic. */
export interface TopicContextFile {
  path: string;
  exists: boolean;
  content: string;
}

export interface Tree {
  folders: Folder[];
  projects: Project[];
}

/** How many open tasks in a project wait their turn. Projects with none aren't listed. */
export interface QueuedCount {
  projectId: number;
  count: number;
}

/** One finished task's saved metrics. Model and effort are null when the CLI default was used. */
export interface TaskMetric {
  projectId: number;
  projectName: string;
  taskId: number;
  topicId: number | null;
  taskTitle: string;
  cli: string;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  completedAt: string;
  durationSeconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  messages: number | null;
}

export interface SearchHit {
  projectId: number;
  projectName: string;
  topicId: number;
  topicTitle: string;
  category: Category;
  /** The name of the category in the hit's project. */
  categoryName: string;
  matchKind: 'title' | 'description' | 'task';
  snippet: string;
  archived: boolean;
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

export interface UsageWindow {
  percent: number;
  resets: string | null;
}

export interface ClaudeUsage {
  session: UsageWindow | null;
  week: UsageWindow | null;
}

export interface AntigravityUsage {
  installed: boolean;
  /** Null on plans without a separate Argon quota. */
  argon: UsageWindow | null;
  /** The limits of the group Gemini Flash belongs to, which it shares with Gemini Pro. Null when agy lists no such group. */
  flashSession: UsageWindow | null;
  flashWeek: UsageWindow | null;
  /** The limits of the group holding the Claude and GPT models agy offers. Separate from the Claude plan. */
  claudeGptSession: UsageWindow | null;
  claudeGptWeek: UsageWindow | null;
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
  /** Complexity rating from 1 to 10 for each task in `tasks`. */
  taskComplexities?: number[];
  /** True for each task in `tasks` that only the user can do. Saved as a prerequisite. */
  taskUserActions?: boolean[];
}

/** Claude's check of a draft: are its tasks enough to finish the topic, what's missing, what requires user action, and what only the user can answer. */
export interface TopicResearch {
  sufficient: boolean;
  summary: string;
  missing: string[];
  questions: string[];
  userActions?: string[];
  prerequisites?: string[];
}

export type TopicReview = TopicResearch;

export interface TopicRefineResult {
  title: string;
  description: string;
  newTasks: string[];
  userActions?: string[];
  prerequisites?: string[];
}

export interface RefinedTopicResponse {
  topic: Topic;
  tasks: Task[];
  addedTasks: Task[];
  newTasksCount: number;
  userActions?: string[];
  prerequisites?: string[];
}


/** The model and reasoning level for one intensity. Null: the CLI's own default. */
export interface DelegationChoice {
  model: string | null;
  effort: string | null;
}

/** The complexity delegation setup, saved as an app setting. Choices go by agent, then intensity 1 to 10. */
export interface DelegationConfig {
  mode: AiService;
  choices: Record<AiService, Record<string, DelegationChoice>>;
}
