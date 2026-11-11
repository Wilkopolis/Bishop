import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import { aiChoiceFor, aiServiceFor, useBishopStore } from '../store/useBishopStore';
import { AI_SERVICE_LABELS, AI_SERVICES, DISPLAY_TYPE_LABELS, type AgentsFile, type AiService, type FolderStatus, type Project, type DisplayType } from '../types';
import { CaretDown, FileText, Folder, FolderOpen, Loader2, WarningCircle, X } from './icons';
import { ContextMenu, Modal, type MenuItem } from './ui';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = 'w-full px-2 py-1.5 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text';
const btn = 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-50';
const primary = `${btn} bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]`;
const secondary = `${btn} border border-[var(--border)] hover:bg-[var(--card)]`;
const normalizeNewlines = (s: string) => s.replace(/\r\n/g, '\n');

/** Folder path input with Browse and a live note on what Bishop will do with the folder. */
function FolderField({ value, onChange, onValidity }: { value: string; onChange: (v: string) => void; onValidity?: (ok: boolean) => void }) {
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const path = value.trim();
    if (!path) {
      setStatus(null);
      setError(null);
      onValidity?.(false);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const s = await api.folderStatus(path);
        if (!alive) return;
        setStatus(s);
        setError(null);
        onValidity?.(!s.isFile);
      } catch (e) {
        if (!alive) return;
        setStatus(null);
        setError(message(e));
        onValidity?.(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  const browse = async () => {
    try {
      const r = await api.pickFolder(value.trim() || undefined, 'Choose the project folder');
      if (r.path) onChange(r.path);
    } catch (e) {
      setError(message(e));
    }
  };

  let note: React.ReactNode = null;
  if (error) note = <span className="text-red-400">{error}</span>;
  else if (status?.isFile) note = <span className="text-red-400">That's a file, not a folder.</span>;
  else if (status && !status.exists) note = 'New folder: Bishop will create it and add an AGENTS.md.';
  else if (status?.hasAgents) note = 'Existing folder with an AGENTS.md: Bishop will use it as is.';
  else if (status) note = 'Existing folder: Bishop will add an AGENTS.md. Nothing else changes.';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          aria-label="Project folder"
          spellCheck={false}
          className={`${field} font-mono text-xs`}
          placeholder="C:\Projects\MyProject"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className={secondary} onClick={browse}>
          <FolderOpen size={14} /> Browse…
        </button>
      </div>
      <p className="text-xs text-[var(--muted-foreground)] min-h-4" data-testid="folder-note">
        {note}
      </p>
    </div>
  );
}

export function NewProjectDialog() {
  const { newProjectDialog, setNewProjectDialog, createProject } = useBishopStore();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [folderEdited, setFolderEdited] = useState(false);
  const [folderOk, setFolderOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!newProjectDialog) return;
    setName('');
    setFolder('');
    setFolderEdited(false);
    setBusy(false);
  }, [newProjectDialog]);

  // The suggested folder follows the name until the user picks or types their own.
  useEffect(() => {
    if (!newProjectDialog || folderEdited) return;
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const s = await api.suggestFolder(name.trim() || 'New project');
        if (alive) setFolder(s.path);
      } catch {}
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [name, folderEdited, newProjectDialog]);

  if (!newProjectDialog) return null;
  const close = () => !busy && setNewProjectDialog(null);
  const canCreate = name.trim().length > 0 && folder.trim().length > 0 && folderOk && !busy;
  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    const ok = await createProject(name.trim(), folder.trim(), newProjectDialog.folderId);
    setBusy(false);
    if (ok) setNewProjectDialog(null);
  };

  return (
    <Modal onClose={close}>
      <form
        data-testid="new-project-dialog"
        className="p-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New project</h2>
          <button type="button" className="p-1 rounded hover:bg-[var(--card)]" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Name</span>
          <input autoFocus aria-label="Project name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Folder</span>
          <FolderField
            value={folder}
            onChange={(v) => {
              setFolder(v);
              setFolderEdited(true);
            }}
            onValidity={setFolderOk}
          />
          <p className="text-xs text-[var(--muted-foreground)]">
            Every project has a folder on disk, such as its code repo. Bishop keeps an AGENTS.md there that tells Claude about the project.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" className={secondary} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={primary} disabled={!canCreate}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Pick/confirm a folder for an existing project (link, relink after a move, or change). */
function LinkFolderForm({ project, onLinked, submitLabel }: { project: Project; onLinked?: () => void; submitLabel: string }) {
  const linkProjectFolder = useBishopStore((s) => s.linkProjectFolder);
  const [folder, setFolder] = useState('');
  const [folderOk, setFolderOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (project.folderPath) setFolder(project.folderPath);
    else
      api.suggestFolder(project.name).then(
        (s) => alive && setFolder(s.path),
        () => {},
      );
    return () => {
      alive = false;
    };
  }, [project.id]);

  const submit = async () => {
    if (!folder.trim() || !folderOk || busy) return;
    setBusy(true);
    const ok = await linkProjectFolder(project.id, folder.trim());
    setBusy(false);
    if (ok) onLinked?.();
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FolderField value={folder} onChange={setFolder} onValidity={setFolderOk} />
      <div>
        <button type="submit" className={primary} disabled={!folder.trim() || !folderOk || busy}>
          {busy && <Loader2 size={14} className="animate-spin" />} {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Shown on the project page until the project has a folder that exists. Can't be dismissed. */
export function FolderBanner({ project }: { project: Project }) {
  const missing = project.folderMissing;
  return (
    <div data-testid="folder-banner" className="rounded-md border border-[var(--primary)] bg-[var(--primary-subtle)] p-4 flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <WarningCircle size={18} className="shrink-0 mt-0.5 text-[var(--primary-text)]" />
        <div className="flex flex-col gap-1 min-w-0">
          <div className="font-medium">{missing ? 'Project folder not found' : 'Choose a folder for this project'}</div>
          <div className="text-sm text-[var(--muted-foreground)] break-words">
            {missing ? (
              <>
                <span className="font-mono text-xs text-[var(--foreground)]">{project.folderPath}</span> was moved, renamed or deleted. Pick
                where it is now, or another folder. Nothing in Bishop was deleted.
              </>
            ) : (
              <>
                Projects now have a folder on disk, such as the project's code repo. Bishop adds an AGENTS.md there that tells Claude about the
                project, and Voice topic runs Claude in that folder.
              </>
            )}
          </div>
        </div>
      </div>
      <LinkFolderForm project={project} submitLabel={missing ? 'Relink folder' : 'Use this folder'} />
    </div>
  );
}

/** Small muted line in the overview: the folder path (click to open it), Edit AGENTS.md and the AI service. */
export function FolderLine({ project }: { project: Project }) {
  const { setAgentsEditorFor, pushError, aiService: generalService, setAiService, aiModels, aiEfforts, setProjectTerminalChoice } = useBishopStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number } | null>(null);
  const setDisplayType = useBishopStore((s) => s.setDisplayType);
  const aiService = aiServiceFor(project, generalService);
  if (!project.folderPath || project.folderMissing) return null;
  const action = 'flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--card)] hover:text-[var(--foreground)] shrink-0';
  const openMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2 });
  };
  // Saves the service, and the model and reasoning pair it would use, so the project keeps what the user sees.
  const pickService = (service: AiService) => {
    const choice = aiChoiceFor(project, service, aiModels, aiEfforts);
    setProjectTerminalChoice(project.id, service, choice.model, choice.effort);
    setAiService(service);
  };
  const menuItems: MenuItem[] = AI_SERVICES.map((s) => ({ label: AI_SERVICE_LABELS[s], checked: s === aiService, onSelect: () => pickService(s) }));
  return (
    <div data-testid="folder-line" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--muted-foreground)] min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <Folder size={13} className="shrink-0" />
        <button
          className="truncate font-mono text-left hover:text-[var(--foreground)] hover:underline"
          title={`Open in Explorer: ${project.folderPath}`}
          onClick={() => api.openProjectFolder(project.id).catch(pushError)}
        >
          {project.folderPath}
        </button>
        <button className={action} title="Edit this project's AGENTS.md" onClick={() => setAgentsEditorFor(project.id)}>
          <FileText size={13} /> Edit AGENTS.md
        </button>
      </div>
      {/* In a narrow window the service button drops to its own row, so it stays on screen. */}
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        <button
          data-testid="display-type"
          className={action}
          title="Choose the display type: Full has the full layout, Compact has only categories and tasks."
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTypeMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          {DISPLAY_TYPE_LABELS[project.displayType]} <CaretDown size={11} />
        </button>
        {project.displayType !== 'personal' && (
          <button
            data-testid="ai-service"
            className={action}
            title="Choose the AI service for new sessions and tasks. A running session keeps its own."
            onClick={(e) => openMenu(e.currentTarget)}
          >
            {AI_SERVICE_LABELS[aiService]} <CaretDown size={11} />
          </button>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {typeMenu && (
        <ContextMenu
          x={typeMenu.x}
          y={typeMenu.y}
          items={(Object.keys(DISPLAY_TYPE_LABELS) as DisplayType[]).map((t) => ({
            label: DISPLAY_TYPE_LABELS[t],
            checked: t === project.displayType,
            onSelect: () => setDisplayType(project.id, t),
          }))}
          onClose={() => setTypeMenu(null)}
        />
      )}
    </div>
  );
}

/** "Change folder…" from the sidebar menu. */
export function ChangeFolderDialog() {
  const { folderDialogFor, setFolderDialogFor, projects } = useBishopStore();
  const project = projects.find((p) => p.id === folderDialogFor);
  if (!project) return null;
  const close = () => setFolderDialogFor(null);
  return (
    <Modal onClose={close}>
      <div data-testid="change-folder-dialog" className="p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Change folder for {project.name}</h2>
          <button className="p-1 rounded hover:bg-[var(--card)]" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-[var(--muted-foreground)]">
          Files aren't moved. Bishop just points the project at this folder, and adds an AGENTS.md there if it doesn't have one.
        </p>
        <LinkFolderForm project={project} submitLabel="Use this folder" onLinked={close} />
      </div>
    </Modal>
  );
}

/** Plain-text editor for the project's AGENTS.md, with a warning if the file changed on disk meanwhile. */
export function AgentsEditor() {
  const { agentsEditorFor, setAgentsEditorFor, projects, pushError, pushInfo, confirm } = useBishopStore();
  const project = projects.find((p) => p.id === agentsEditorFor);
  const [file, setFile] = useState<AgentsFile | null>(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async (id: number) => {
    try {
      const f = await api.getAgents(id);
      setFile(f);
      setText(normalizeNewlines(f.content));
      setConflict(false);
      setLoadError(null);
    } catch (e) {
      setLoadError(message(e));
    }
  };

  useEffect(() => {
    setFile(null);
    setText('');
    setConflict(false);
    setLoadError(null);
    if (agentsEditorFor != null) load(agentsEditorFor);
  }, [agentsEditorFor]);

  if (!project) return null;
  const dirty = file != null && text !== normalizeNewlines(file.content);

  const save = async (force = false) => {
    if (!file || saving) return;
    setSaving(true);
    try {
      const f = await api.saveAgents(project.id, text, file.hash, force);
      setFile(f);
      setText(normalizeNewlines(f.content));
      setConflict(false);
      pushInfo('AGENTS.md saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'changed_on_disk') setConflict(true);
      else pushError(e);
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: "Your edits to AGENTS.md haven't been saved.", confirmLabel: 'Discard' }))) return;
    setAgentsEditorFor(null);
  };

  return (
    <Modal onClose={close}>
      <div data-testid="agents-editor" className="p-5 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">AGENTS.md</h2>
            <div className="text-xs text-[var(--muted-foreground)] font-mono truncate" title={file?.path}>
              {file?.path ?? project.folderPath}
            </div>
          </div>
          <button className="p-1 rounded hover:bg-[var(--card)]" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>

        {loadError && <div className="px-3 py-2 rounded border border-red-800 bg-red-950/60 text-sm text-red-200">{loadError}</div>}

        {conflict && (
          <div data-testid="agents-conflict" className="flex flex-col gap-2 px-3 py-2 rounded border border-[var(--primary)] bg-[var(--primary-subtle)] text-sm">
            <span>AGENTS.md was changed outside Bishop since you opened it.</span>
            <div className="flex gap-2">
              <button className={secondary} onClick={() => load(project.id)}>
                Reload from disk (discard my edits)
              </button>
              <button className={primary} onClick={() => save(true)}>
                Overwrite with my version
              </button>
            </div>
          </div>
        )}

        <textarea
          aria-label="AGENTS.md content"
          spellCheck={false}
          className={`${field} font-mono text-xs leading-relaxed h-[55vh] resize-y`}
          value={text}
          disabled={!file}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              save();
            }
          }}
        />

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--muted-foreground)]">{dirty ? 'Unsaved changes · Ctrl+S to save' : 'Saved'}</span>
          <div className="flex gap-2">
            <button className={secondary} onClick={close}>
              Close
            </button>
            <button className={primary} onClick={() => save()} disabled={!dirty || saving}>
              {saving && <Loader2 size={14} className="animate-spin" />} Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
