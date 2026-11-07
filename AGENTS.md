# Bishop

A local, offline project manager for Windows: projects hold topics, topics hold task checklists, and a voice note can become a topic.

## About this project

Bishop is a single-user desktop app (Windows only). It is a React frontend inside a .NET WebView2
window, talking to an ASP.NET minimal API in the same process. Everything is stored locally in SQLite.
`README.md` is the full reference (features, settings, data layout, schema, API table); read it before
changing behavior.

**Stack**

- Frontend (`src/`): React 19, TypeScript, Vite 6, Tailwind 4, Zustand. dnd-kit for drag and drop,
  xterm.js for the terminal panel.
- Desktop host (`desktop-host/`, .NET 10 WinForms + WebView2): the Vite build (`dist/`) is embedded
  into `Bishop.exe` as resources.
- Storage: Microsoft.Data.Sqlite. `index.db` holds the folder/project tree; each project has its own
  `projects\<guid>.db` (topics, tasks, picture). Data root defaults to `%LOCALAPPDATA%\Bishop\`.
- Voice topics: Whisper.net (CUDA, then Vulkan, then CPU) transcribes locally; the Claude Code CLI
  (`claude -p`) drafts a topic that the user reviews before saving.
- Terminal: Porta.Pty (ConPTY) in the host, xterm.js in the UI, over a loopback-only WebSocket.

**Where things are**

| area | files |
|------|-------|
| API routes | `desktop-host/Api.cs` |
| SQLite access and migrations | `desktop-host/Storage.cs` |
| Startup, ports, static files | `desktop-host/Program.cs`, `desktop-host/BishopWindow.cs` |
| Settings (flag, env var, settings.json) and `ApiProblem` | `desktop-host/AppSettings.cs` |
| Project folders and AGENTS.md template | `desktop-host/ProjectFolders.cs` |
| Voice: Whisper / Claude CLI | `desktop-host/Transcriber.cs`, `desktop-host/ClaudeCli.cs` |
| Terminal sessions (Claude, Antigravity `agy`, PowerShell) | `desktop-host/Terminals.cs`, `desktop-host/AntigravityCli.cs` |
| Backups | `desktop-host/Backups.cs` |
| Task briefs and topic context files | `desktop-host/TaskBriefs.cs`, `desktop-host/TopicContext.cs` |
| Frontend API client and shared types | `src/api/client.ts`, `src/types/index.ts` |
| App state | `src/store/useBishopStore.ts` |
| UI | `src/components/` |
| Theme colors (CSS variables) | `src/index.css` |

## Building and checking changes

There is no test suite. Before calling a change done:

- `npm run build`: type-checks (`tsc -b`) and builds the frontend.
- `npm run build:standalone`: also builds the host into `release\Bishop.exe`. Close any running Bishop
  first or the build can't overwrite the exe.
- Dev loop: `npm run dev:api` (host in `--api-only` mode on port 45900) plus `npm run dev` (Vite on
  5173, proxies `/api` and the terminal WebSocket). Window-control endpoints do nothing in this mode.
- `npm run publish:zip` makes the portable self-contained zip; the version comes from `package.json`.

## Conventions

- **README updates are paused.** For now, don't update `README.md` when functionality changes, unless
  the task asks for it. This also pauses the README steps in the schema and commit conventions below.
  The README may lag behind the code until this is lifted. If you do add a screenshot, it goes in
  `docs/screenshots/` with the next number (`14-...png`).
- **Schema changes are migrations.** Each database tracks its version with `PRAGMA user_version`; add a
  new step in `Storage.cs` that upgrades from the previous version (never edit an old step), and update
  the Schema section of the README with the version it was added in.
- **API shape.** JSON in and out. Errors are `{ "error": "...", "code"?: "..." }`; throw `ApiProblem`
  (status, code, message) for errors the UI should handle specifically. Keep `src/types/index.ts` and
  `src/api/client.ts` in step with the host.
- **User data is precious.** Bishop never deletes, moves or overwrites anything in a project's folder; it
  only creates `AGENTS.md` when missing (`FileMode.CreateNew`) and saves it with a hash check so outside
  edits aren't clobbered. Deleted projects move to `trash\`, never destroyed. Keep it that way.
- **Security.** The server listens on loopback only, the terminal WebSocket checks the origin, and
  transcripts go to the Claude CLI over stdin, never on the command line. Don't pass permission flags to
  `claude`. Antigravity is the one exception: Terminal sessions start `agy` with
  `--dangerously-skip-permissions`, by the user's choice, so it acts without asking. Only open http/https
  links externally.
- **Claude reports finished tasks itself.** A task brief (`TaskBriefs.cs`) gives Claude the exact
  `POST /api/projects/{pid}/tasks/{taskId}/complete` call, with the ids filled in, and Claude runs it only
  when the work is really done. Don't infer completion from terminal output, a session ending, or hooks:
  Claude may stop with work left or a question for the user. The UI ticks tasks with `PATCH`, so
  `/complete` means "Claude finished this". Only sessions started from a task report; a plain Terminal
  session has no task id.
- **Topic context files.** The `/complete` call can carry a summary of the steps taken as its body. Bishop
  appends it to `<data root>\context\<project id>\topic-<topic id>.md`, not the project folder. Backups
  copy these files, and deleting a topic or project moves them to `trash\`. Ticking a task in the UI adds
  nothing, because there are no steps to report. When the topic has a context file, the task brief tells
  Claude to read it before starting. A task that continues the topic's session (Same session) skips both:
  Claude already knows the work, so its brief names no context file and asks for no summary.
- **Icons.** `src/components/icons.tsx` is generated by `scripts/gen-icons.py` (Phosphor, inlined).
  Add an entry to its `ICONS` list and re-run it rather than hand-editing. App icon and favicons come
  from `scripts/gen-app-icon.py`.
- **Styling.** Use the CSS variables in `src/index.css` (warm gray + orange) instead of hard-coded colors.
- **Writing style** (UI text, README, comments, commit messages): plain, short sentences. No em dashes;
  use a colon, comma or a new sentence instead.
- **Commits.** A short imperative title, then a bullet list of what changed and why, ending with the
  README/screenshot updates.

## Notes for agents

This project is tracked in **Bishop**, a local project manager (this repo is Bishop itself). Bishop
organizes work into **topics** (a piece of work or an idea, with a short description) and each topic has
a checklist of **tasks**. Every topic sits in one category. Projects can add and remove categories;
these are the ones a project starts with:

- **RIGHT NOW**: being worked on now, or urgent
- **SOON**: next up
- **LATER**: planned, but not soon
- **BACKLOG**: someday, ideas, or unclear timing

When Bishop asks you to turn a voice note into a topic, follow the conventions above and any
project-specific instructions in this file.

## Project-specific instructions

- Topic titles name the feature or fix from the user's point of view, e.g. "Export a project to
  Markdown" or "Terminal loses scrollback after restart", not implementation details.
- Name things the way the app does: project, folder, topic, task, overview, sidebar, Voice topic,
  Terminal, backups, AGENTS.md.
- Split work into tasks a person could tick off in one sitting. When a topic changes a database,
  include "Add schema migration".
