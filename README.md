# Bishop

A local, offline project management app for Windows.

- **Frontend:** React 19 + TypeScript + Vite 6 + Tailwind 4 + Zustand (`src/`, built to `dist/`). Icons are [Phosphor](https://phosphoricons.com) (MIT), inlined by `scripts/gen-icons.py` into `src/components/icons.tsx`; theme colors (warm gray + orange) are CSS variables in `src/index.css`. The app icon and logo are Kenney's chess bishop ([Board Game Icons](https://kenney.nl), CC0); `scripts/gen-app-icon.py` builds `desktop-host/app.ico` and the favicons from it.
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

### Portable zip (no .NET needed on the target PC)

```bat
publish-standalone.bat   :: or: npm run publish:zip
```

Produces a self-contained win-x64 folder in `release\publish\Bishop-<version>-win-x64\` and zips it to `release\Bishop-<version>-win-x64.zip` (~230 MB, mostly the Whisper GPU runtimes). Unzip anywhere and run `Bishop.exe`. The version comes from `package.json`.

## Using Bishop

- **Project folder & AGENTS.md:** every project is linked to a folder on disk (its code repo, or one Bishop creates under `Documents\Bishop\<name>`). Bishop adds an `AGENTS.md` there if there isn't one (it never overwrites or deletes anything in the folder). The overview shows the path (click it to open the folder in Explorer) with *Edit AGENTS.md*; the sidebar menu has *Change folder…* (relinks, no files move). Projects created before folders existed, or whose folder was moved, show a banner to pick one. Voice topic runs Claude in this folder, so Claude Code reads `AGENTS.md` (verified with Claude Code 2.1.317, which reads `AGENTS.md` natively, so Bishop doesn't add a `CLAUDE.md`). Deleting a project in Bishop never touches its folder.
- **Project overview:** the panel at the top shows the title and tagline (click either to edit the tagline), task progress, and an optional picture. Add a picture by clicking the dashed box (it appears on hover), dropping an image file onto the panel, or pasting one; hover the picture to replace or remove it. Pictures are downscaled to 1600 px before upload.
- **Projects & folders:** right-click (or the `…` button) for rename / move / delete; double-click to rename. Drag projects onto a folder, onto another project (to go above it), or onto the empty area at the bottom to move them out of a folder.
- **Topics:** the Right now / Soon / Later / Backlog sections are stacked top to bottom; each wraps its cards in a grid and can be collapsed (remembered per project). Drag a card within a section to reorder it, or into another section: an orange bar shows exactly where it will land (empty sections and collapsed headers take it at the end). Keyboard: focus a card, Space to pick up, arrow keys to move (Up/Down step between sections), Space to drop, Esc to cancel; Enter opens the card.
- **Archive a topic:** open a topic and click *Archive topic*. It leaves the board and stops counting toward the overview's task progress, and Voice topic no longer lists it for Claude. Nothing is deleted. Archived topics sit in the collapsed *Archived* section under the board, newest first; click one to open it, or *Restore* to put it back in its section.
- **Tasks:** in a topic, drag the grip handle (or focus it, Space, arrows, Space) to reorder.
- **Work on a task with Claude:** hover an open task and click the arrow. The topic closes, the Terminal opens, and a new Claude session starts in the project folder (if the project already has a session, Bishop asks first, since that session ends). Bishop writes a brief to `<data root>\work\` with the topic title, category and description, every task in the topic with its done state, and which one to work on; Claude gets a short prompt that points at that file, so task text never goes on a command line. When Claude finishes, it marks the task done by calling Bishop's local API with `curl.exe` (Claude asks before running it, like any command). While the Terminal is open, Bishop reloads the topics every few seconds so the tick shows up. Briefs older than 7 days are deleted.
- **Search:** Ctrl+K or Ctrl+F searches topic titles, descriptions and task titles in every project, including archived topics (marked *Archived*). Arrow keys + Enter open the topic.
- **Voice topic:** click the microphone button at the bottom left of the sidebar (select a project first). Recording stays in that corner, with a live waveform of the microphone level and the recording duration: click stop to transcribe locally, or the X to discard. The small button at the right of that strip transcribes an audio file instead. A dialog then shows the transcript and asks Claude for a draft topic you edit before saving. The topic goes to the project selected at that point.
- **Terminal:** Ctrl+` (or *Terminal* in the title bar) opens a panel at the bottom running the interactive `claude` CLI in the selected project's folder, so it reads that folder's `AGENTS.md`. It's a real pseudo-terminal (Windows ConPTY + xterm.js). Each project keeps its own session while you switch projects; *Restart* starts it again and *New ▾* opens a fresh Claude or PowerShell session. Drag the top edge to resize (remembered). Ctrl+C copies a selection (otherwise it goes to the program), Ctrl+Shift+C / Ctrl+Shift+V copy and paste, right-click copies or pastes; links open in your browser. Claude's normal permission prompts apply (Bishop passes no permission flags). Terminal processes are in a Windows Job Object, so they're killed with Bishop, even if it crashes.
- **Backups:** the gear icon in the sidebar has *Back up now*, *Open backups folder*, and shows the last backup.

## Backups & restore

On startup Bishop makes one backup per day (and whenever you click *Back up now*) to `<data root>\backups\<yyyyMMdd-HHmmss>\`, using SQLite `VACUUM INTO` so the copies are consistent even while the app is running. The newest 14 are kept.

Each backup folder mirrors the data root:

```
backups\20261103-091500\
  index.db
  projects\<guid>.db
```

To restore:

1. Close Bishop.
2. Optionally copy the current `index.db` and `projects\` somewhere safe.
3. Copy `index.db` and the `projects\` folder from the backup into the data root (default `%LOCALAPPDATA%\Bishop\`), replacing the existing files. To restore a single project, copy only its `projects\<guid>.db` (the guid is the `file_name` column in `index.db`'s `projects` table).
4. Delete any `index.db-wal` / `index.db-shm` files left next to `index.db`, then start Bishop.

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
| Claude CLI | `--claude` | `BISHOP_CLAUDE_PATH` | `claudePath` | PATH, `~\.local\bin`, then the Claude desktop app's bundled copy |
| Claude model | | | `claudeModel` | CLI default |
| New-project folder root | `--projects-root` | `BISHOP_PROJECTS_ROOT` | `projectsRoot` | `Documents\Bishop` (suggested folder = root\project name) |

The Whisper model (~1.6 GB) is downloaded from Hugging Face (`ggerganov/whisper.cpp`) the first time you click the **Voice topic** microphone. A dialog asks first, then progress shows in the record element at the bottom left of the sidebar. The download keeps running while you use the rest of the app. Logs go to `%LOCALAPPDATA%\Bishop\bishop.log` (including which Whisper backend loaded).

```
<data root>\
  index.db              folders + projects tree
  models\               Whisper model files (never in the repo)
  backups\              daily/manual backups (newest 14 kept)
  work\                 task briefs for Claude (older than 7 days deleted)
  projects\<guid>.db    one database per project (topics + tasks)
  trash\                deleted project databases (moved, not destroyed)
```

Window state (`window.json`) and the WebView2 profile always live in `%LOCALAPPDATA%\Bishop\`.

## Schema

**index.db**

| table    | columns |
|----------|---------|
| folders  | id, name, parent_id → folders, sort_order, created_at |
| projects | id, name, folder_id → folders, file_name, sort_order, created_at, updated_at, tagline (nullable, ≤200 chars; schema v2), image_version (nullable; set when the project has a picture, used as a cache key; schema v3), folder_path (the project's working folder on disk; NULL for projects from before v4) |

**projects/&lt;guid&gt;.db**

| table  | columns |
|--------|---------|
| topics | id, title, description, category (`RIGHT_NOW` \| `SOON` \| `LATER` \| `BACKLOG`), sort_order, created_at, updated_at, archived_at (nullable; set while the topic is archived; schema v3) |
| tasks  | id, topic_id → topics (cascade delete), title, completed (0/1), sort_order, created_at, completed_at |
| project_image | id (always 1), mime, data (blob), updated_at: the optional project picture, kept in the project's own file so backups and trash include it (schema v2) |

Categories apply to topics, not tasks. Each database tracks its schema with `PRAGMA user_version`.

## API

All JSON. Errors return `{ "error": "..." }` with 400 or 404.

| method | path | body |
|--------|------|------|
| GET    | `/api/tree` | returns `{ folders, projects }` |
| POST   | `/api/folders` | `{ name, parentId? }` |
| PATCH  | `/api/folders/{id}` | `{ name?, parentId? }` (`parentId: null` moves to root) |
| DELETE | `/api/folders/{id}` | children move up to the parent folder |
| POST   | `/api/projects` | `{ name, folderPath, folderId?, tagline? }`: folderPath is required (absolute); the folder is created if missing and gets an AGENTS.md if it has none |
| PATCH  | `/api/projects/{id}` | `{ name?, folderId?, tagline?, folderPath? }` (tagline: trimmed, blank or `null` clears, >200 chars → 400; folderPath relinks, no files move) |
| GET    | `/api/project-folders/suggest?name=` | `{ root, path }` default folder for a new project |
| GET    | `/api/project-folders/status?path=` | `{ path, exists, hasAgents, isFile }` |
| POST   | `/api/system/pick-folder` | `{ initial?, title? }` → native folder picker → `{ path \| null }` |
| POST   | `/api/projects/{id}/open-folder` | opens the project folder in Explorer |
| GET    | `/api/terminal/sessions?projectId=` | terminal sessions `{ id, projectId, kind, title, cwd, alive, exitCode }` |
| POST   | `/api/terminal/sessions` | `{ projectId, kind: "claude" \| "shell", cols, rows, taskId? }` → starts a session in the project folder; `taskId` (claude only) writes a task brief and starts Claude on it |
| DELETE | `/api/terminal/sessions/{id}` | ends the session and its processes |
| WS     | `/api/terminal/ws/{id}` | loopback origins only. Client → `{type:"input",data}` / `{type:"resize",cols,rows}`; server → `replay` (scrollback on attach), `output`, `exit` |
| GET    | `/api/projects/{id}/agents` | `{ path, exists, content, hash }` |
| PUT    | `/api/projects/{id}/agents` | `{ content, baseHash, force? }`: 409 `changed_on_disk` if the file changed since it was loaded |
| POST   | `/api/projects/reorder` | `{ folderId, projectIds }`: puts these projects, in order, into a folder (null = root) |
| DELETE | `/api/projects/{id}` | project db moved to `trash\` |
| GET    | `/api/projects/{id}/image?v=` | the project picture (immutable cache per `imageVersion`) |
| POST   | `/api/projects/{id}/image` | raw PNG/JPEG/WebP/GIF body, ≤20 MB; type sniffed from bytes; PNG/JPEG over 1600 px downscaled; returns the project |
| DELETE | `/api/projects/{id}/image` | removes the picture; returns the project |
| GET    | `/api/projects/{pid}/topics` | topics, each with `tasks` and `archivedAt` (archived topics included) |
| POST   | `/api/projects/{pid}/topics` | `{ title, description?, category? }` (default `BACKLOG`) |
| POST   | `/api/projects/{pid}/topics/reorder` | `{ category, topicIds }`: full ordered list for one column |
| PATCH  | `/api/projects/{pid}/topics/{tid}` | `{ title?, description?, category?, sortOrder?, archived? }` (`archived: true` archives, `false` restores) |
| DELETE | `/api/projects/{pid}/topics/{tid}` | |
| GET    | `/api/projects/{pid}/topics/{tid}/tasks` | |
| POST   | `/api/projects/{pid}/topics/{tid}/tasks` | `{ title }` |
| POST   | `/api/projects/{pid}/topics/{tid}/tasks/reorder` | `{ taskIds }` |
| PATCH  | `/api/projects/{pid}/tasks/{taskId}` | `{ title?, completed?, sortOrder? }` |
| POST   | `/api/projects/{pid}/tasks/{taskId}/complete` | no body; marks the task done (used by Claude from a task brief) |
| DELETE | `/api/projects/{pid}/tasks/{taskId}` | |
| GET    | `/api/search?q=` | matches in topic titles, descriptions and task titles across all projects; each hit has `archived` |
| GET    | `/api/backups` | `{ folder, keep, backups }` |
| POST   | `/api/backups` | back up now |
| POST   | `/api/backups/open` | opens the backups folder in Explorer |
| GET    | `/api/voice/status` | Whisper model state/download progress/backend, Claude CLI path |
| POST   | `/api/voice/model/download` | starts the model download |
| POST   | `/api/transcribe` | body: 16 kHz mono 16-bit WAV → `{ text, backend, audioSeconds, elapsedMs, loadMs }` |
| POST   | `/api/projects/{pid}/topic-from-transcript` | `{ transcript }` → `{ title, description, category, tasks }` (draft only; nothing saved) |
| POST   | `/api/window/{drag\|resize\|minimize\|maximize\|close}` | frameless window controls |
| GET    | `/api/health` | `{ ok, dataRoot }` |
