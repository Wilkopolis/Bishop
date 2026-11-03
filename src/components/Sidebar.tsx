import { useState } from 'react';
import { Folder as FolderIcon, FolderPlus, NotebookText, Plus, Trash2 } from 'lucide-react';
import { useBishopStore } from '../store/useBishopStore';
import type { Folder, Project } from '../types';

function ProjectRow({ project, depth }: { project: Project; depth: number }) {
  const { selectedProjectId, selectProject, deleteProject } = useBishopStore();
  const selected = selectedProjectId === project.id;
  return (
    <div
      className={`group flex items-center gap-2 pr-2 py-1 rounded cursor-pointer text-sm ${
        selected ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'hover:bg-[var(--card)]'
      }`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => selectProject(project.id)}
    >
      <NotebookText size={14} className="shrink-0" />
      <span className="truncate flex-1">{project.name}</span>
      <button
        className="opacity-0 group-hover:opacity-70 hover:!opacity-100"
        title="Delete project"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete project "${project.name}"?`)) deleteProject(project.id);
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function FolderNode({ folder, depth }: { folder: Folder; depth: number }) {
  const { folders, projects } = useBishopStore();
  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 text-xs uppercase tracking-wide text-[var(--muted-foreground)]"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <FolderIcon size={13} />
        <span className="truncate">{folder.name}</span>
      </div>
      {folders
        .filter((f) => f.parentId === folder.id)
        .map((f) => (
          <FolderNode key={`f${f.id}`} folder={f} depth={depth + 1} />
        ))}
      {projects
        .filter((p) => p.folderId === folder.id)
        .map((p) => (
          <ProjectRow key={`p${p.id}`} project={p} depth={depth + 1} />
        ))}
    </div>
  );
}

type Draft = { kind: 'project' | 'folder'; name: string } | null;

export function Sidebar() {
  const { folders, projects, createProject, createFolder, loading } = useBishopStore();
  const [draft, setDraft] = useState<Draft>(null);

  const submit = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    setDraft(null);
    if (!name) return;
    if (draft.kind === 'project') await createProject(name);
    else await createFolder(name);
  };

  return (
    <aside className="w-64 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Projects</span>
        <div className="flex gap-1">
          <button
            className="p-1 rounded hover:bg-[var(--card)]"
            title="New folder"
            onClick={() => setDraft({ kind: 'folder', name: '' })}
          >
            <FolderPlus size={15} />
          </button>
          <button
            className="p-1 rounded hover:bg-[var(--card)]"
            title="New project"
            onClick={() => setDraft({ kind: 'project', name: '' })}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      {draft && (
        <div className="px-2 pb-2">
          <input
            autoFocus
            className="w-full px-2 py-1 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)]"
            placeholder={draft.kind === 'project' ? 'Project name' : 'Folder name'}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setDraft(null);
            }}
            onBlur={submit}
          />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-1 pb-2">
        {folders
          .filter((f) => f.parentId === null)
          .map((f) => (
            <FolderNode key={`f${f.id}`} folder={f} depth={0} />
          ))}
        {projects
          .filter((p) => p.folderId === null)
          .map((p) => (
            <ProjectRow key={`p${p.id}`} project={p} depth={0} />
          ))}
        {!loading && folders.length === 0 && projects.length === 0 && !draft && (
          <button
            className="w-full mt-4 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            onClick={() => setDraft({ kind: 'project', name: '' })}
          >
            + New project
          </button>
        )}
      </nav>
    </aside>
  );
}
