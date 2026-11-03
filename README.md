# Bishop

A local, offline project management app for Windows.

- **Frontend:** React 19 + TypeScript + Vite 6 + Tailwind 4 + Zustand + lucide-react (`src/`, built to `dist/`)
- **Desktop host:** .NET 10 WinForms + WebView2 with an embedded ASP.NET minimal API (`desktop-host/`). The Vite build is embedded into `Bishop.exe`.
- **Storage:** SQLite via Microsoft.Data.Sqlite. One index database for the folder/project tree, one database per project.
- **Voice topics:** local speech-to-text with [Whisper.net](https://github.com/sandrohanea/whisper.net) (CUDA → Vulkan → CPU), then the Claude Code CLI drafts a topic you review before saving.

## Prerequisites

- Node.js 20+
- .NET 10 SDK
- WebView2 Runtime (ships with Windows 11)
- For voice topics:
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), signed in (`npm install -g @anthropic-ai/claude-code`, then run `claude` once)
  - Microphone access for desktop apps (Windows Settings > Privacy & security > Microphone)
  - Optional: NVIDIA CUDA 13 Toolkit (provides `cublas64_13.dll`) for the CUDA backend. Without it Bishop uses the Vulkan GPU backend, which only needs the graphics driver.

## Build & run

```bat
npm install
build-standalone.bat     :: npm run build + dotnet build -> release\Bishop.exe
launch-desktop.bat       :: runs release\Bishop.exe (builds first if missing)
```

Or directly: `npm run build:standalone`, then `release\Bishop.exe`.

## Development

Run the API and the Vite dev server in two terminals:

```bat
npm run dev:api   :: .NET host in --api-only mode on http://127.0.0.1:45900
npm run dev       :: Vite on http://localhost:5173, proxies /api -> 45900
```

Window-control endpoints are no-ops in `--api-only` mode.

## Data location & settings

Default data root is `%LOCALAPPDATA%\Bishop\`. Settings resolve from a command-line flag, then an environment variable, then `%LOCALAPPDATA%\Bishop\settings.json`:

| setting | flag | env var | settings.json key | default |
|---------|------|---------|-------------------|---------|
| data root | `--data-dir` | `BISHOP_DATA_DIR` | `dataDir` | `%LOCALAPPDATA%\Bishop` |
| Whisper model file | `--whisper-model` | `BISHOP_WHISPER_MODEL` | `whisperModelPath` | `<data root>\models\ggml-<model>.bin` |
| Whisper model name | | | `whisperModel` | `large-v3-turbo` |
| Claude CLI | `--claude` | `BISHOP_CLAUDE_PATH` | `claudePath` | PATH, `~\.localbin`, then the Claude desktop app's bundled copy |
| Claude model | | | `claudeModel` | CLI default |

The Whisper model (~1.6 GB) is downloaded from Hugging Face (`ggerganov/whisper.cpp`) the first time you open **Voice topic**, with progress shown in the dialog. Logs go to `%LOCALAPPDATA%\Bishopbishop.log` (including which Whisper backend loaded).

```
<data root>\
  index.db              folders + projects tree
  models\               Whisper model files (never in the repo)
  projects\<guid>.db    one database per project (topics + tasks)
  trash\                deleted project databases (moved, not destroyed)
```

Window state (`window.json`) and the WebView2 profile always live in `%LOCALAPPDATA%\Bishop\`.

## Schema

**index.db**

| table    | columns |
|----------|---------|
| folders  | id, name, parent_id → folders, sort_order, created_at |
| projects | id, name, folder_id → folders, file_name, sort_order, created_at, updated_at |

**projects/&lt;guid&gt;.db**

| table  | columns |
|--------|---------|
| topics | id, title, description, category (`RIGHT_NOW` \| `SOON` \| `LATER` \| `BACKLOG`), sort_order, created_at, updated_at |
| tasks  | id, topic_id → topics (cascade delete), title, completed (0/1), sort_order, created_at, completed_at |

Categories apply to topics, not tasks. Each database tracks its schema with `PRAGMA user_version`.

## API

All JSON. Errors return `{ "error": "..." }` with 400 or 404.

| method | path | body |
|--------|------|------|
| GET    | `/api/tree` | returns `{ folders, projects }` |
| POST   | `/api/folders` | `{ name, parentId? }` |
| PATCH  | `/api/folders/{id}` | `{ name?, parentId? }` (`parentId: null` moves to root) |
| DELETE | `/api/folders/{id}` | children move up to the parent folder |
| POST   | `/api/projects` | `{ name, folderId? }` |
| PATCH  | `/api/projects/{id}` | `{ name?, folderId? }` |
| DELETE | `/api/projects/{id}` | project db moved to `trash\` |
| GET    | `/api/projects/{pid}/topics` | topics, each with `tasks` |
| POST   | `/api/projects/{pid}/topics` | `{ title, description?, category? }` (default `BACKLOG`) |
| PATCH  | `/api/projects/{pid}/topics/{tid}` | `{ title?, description?, category?, sortOrder? }` |
| DELETE | `/api/projects/{pid}/topics/{tid}` | |
| GET    | `/api/projects/{pid}/topics/{tid}/tasks` | |
| POST   | `/api/projects/{pid}/topics/{tid}/tasks` | `{ title }` |
| PATCH  | `/api/projects/{pid}/tasks/{taskId}` | `{ title?, completed?, sortOrder? }` |
| DELETE | `/api/projects/{pid}/tasks/{taskId}` | |
| GET    | `/api/voice/status` | Whisper model state/download progress/backend, Claude CLI path |
| POST   | `/api/voice/model/download` | starts the model download |
| POST   | `/api/transcribe` | body: 16 kHz mono 16-bit WAV → `{ text, backend, audioSeconds, elapsedMs, loadMs }` |
| POST   | `/api/projects/{pid}/topic-from-transcript` | `{ transcript }` → `{ title, description, category, tasks }` (draft only; nothing saved) |
| POST   | `/api/window/{drag\|resize\|minimize\|maximize\|close}` | frameless window controls |
| GET    | `/api/health` | `{ ok, dataRoot }` |
