import { createContext, useContext, useState, type MouseEvent } from 'react';
import { Folder as FolderIcon, FolderPlus, MoreHorizontal, NotebookText, Plus } from 'lucide-react';
import { useBishopStore } from '../store/useBishopStore';
import type { Folder, Project } from '../types';
import { ContextMenu, InlineInput, type MenuItem } from './ui';

type Ref = { kind: 'project' | 'folder'; id: number };
type Draft = { kind: 'project' | 'folder'; parentId: number | null };

interface SidebarCtx {
  editing: Ref | null;
  setEditing: (r: Ref | null) => void;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  openMenu: (e: MouseEvent, items: MenuItem[]) => void;
}

const Ctx = createContext<SidebarCtx>(null!);

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 });

function folderPath(folders: Folder[], id: number): string {
  const parts: string[] = [];
  for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f!.parentId)) {
    parts.unshift(f.name);
  }
  return parts.join(' / ');
}

function DraftRow({ depth }: { depth: number }) {
  const { draft, setDraft } = useContext(Ctx);
  const { createProject, createFolder } = useBishopStore();
  if (!draft) return null;
  return (
    <div className="py-0.5 pr-2" style={indent(depth)}>
      <InlineInput
        placeholder={draft.kind === 'project' ? 'Project name' : 'Folder name'}
        onCommit={(name) => {
          setDraft(null);
          if (draft.kind === 'project') createProject(name, draft.parentId);
          else createFolder(name, draft.parentId);
        }}
        onCancel={() => setDraft(null)}
      />
    </div>
  );
}

function ProjectRow({ project, depth }: { project: Project; depth: number }) {
  const { selectedProjectId, selectProject, renameProject, moveProject, deleteProject, folders } = useBishopStore();
  const { editing, setEditing, openMenu } = useContext(Ctx);
  const selected = selectedProjectId === project.id;

  if (editing?.kind === 'project' && editing.id === project.id) {
    return (
      <div className="py-0.5 pr-2" style={indent(depth)}>
        <InlineInput initial={project.name} onCommit={(n) => { setEditing(null); renameProject(project.id, n); }} onCancel={() => setEditing(null)} />
      </div>
    );
  }

  const menu: MenuItem[] = [
    { label: 'Rename', onSelect: () => setEditing({ kind: 'project', id: project.id }) },
    {
      label: 'Move to',
      children: [
        { label: '(No folder)', disabled: project.folderId === null, onSelect: () => moveProject(project.id, null) },
        ...folders
          .map((f) => ({ id: f.id, path: folderPath(folders, f.id) }))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((f) => ({ label: f.path, disabled: project.folderId === f.id, onSelect: () => moveProject(project.id, f.id) })),
      ],
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => confirm(`Delete project "${project.name}"?`) && deleteProject(project.id),
    },
  ];

  return (
    <div
      className={`group flex items-center gap-2 pr-1 py-1 rounded cursor-pointer text-sm ${
        selected ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'hover:bg-[var(--card)]'
      }`}
      style={indent(depth)}
      onClick={() => selectProject(project.id)}
      onDoubleClick={() => setEditing({ kind: 'project', id: project.id })}
      onContextMenu={(e) => openMenu(e, menu)}
    >
      <NotebookText size={14} className="shrink-0" />
      <span className="truncate flex-1">{project.name}</span>
      <button
        className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100"
        title="Project actions"
        onClick={(e) => { e.stopPropagation(); openMenu(e, menu); }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

function FolderNode({ folder, depth }: { folder: Folder; depth: number }) {
  const { folders, projects, renameFolder, deleteFolder } = useBishopStore();
  const { editing, setEditing, draft, setDraft, openMenu } = useContext(Ctx);

  const menu: MenuItem[] = [
    { label: 'New project here', onSelect: () => setDraft({ kind: 'project', parentId: folder.id }) },
    { label: 'New subfolder', onSelect: () => setDraft({ kind: 'folder', parentId: folder.id }) },
    { label: 'Rename', onSelect: () => setEditing({ kind: 'folder', id: folder.id }) },
    {
      label: 'Delete folder',
      danger: true,
      onSelect: () =>
        confirm(`Delete folder "${folder.name}"? Its projects and subfolders move up one level.`) && deleteFolder(folder.id),
    },
  ];

  return (
    <div>
      {editing?.kind === 'folder' && editing.id === folder.id ? (
        <div className="py-0.5 pr-2" style={indent(depth)}>
          <InlineInput initial={folder.name} onCommit={(n) => { setEditing(null); renameFolder(folder.id, n); }} onCancel={() => setEditing(null)} />
        </div>
      ) : (
        <div
          className="group flex items-center gap-2 pr-1 py-1 rounded text-xs uppercase tracking-wide text-[var(--muted-foreground)] hover:bg-[var(--card)]"
          style={indent(depth)}
          onDoubleClick={() => setEditing({ kind: 'folder', id: folder.id })}
          onContextMenu={(e) => openMenu(e, menu)}
        >
          <FolderIcon size={13} className="shrink-0" />
          <span className="truncate flex-1">{folder.name}</span>
          <button
            className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100"
            title="Folder actions"
            onClick={(e) => openMenu(e, menu)}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}
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
      {draft?.parentId === folder.id && <DraftRow depth={depth + 1} />}
    </div>
  );
}

export function Sidebar() {
  const { folders, projects, loading } = useBishopStore();
  const [editing, setEditing] = useState<Ref | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <Ctx.Provider value={{ editing, setEditing, draft, setDraft, openMenu }}>
      <aside className="w-64 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Projects</span>
          <div className="flex gap-1">
            <button className="p-1 rounded hover:bg-[var(--card)]" title="New folder" onClick={() => setDraft({ kind: 'folder', parentId: null })}>
              <FolderPlus size={15} />
            </button>
            <button className="p-1 rounded hover:bg-[var(--card)]" title="New project" onClick={() => setDraft({ kind: 'project', parentId: null })}>
              <Plus size={15} />
            </button>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-1 pb-2">
          {draft?.parentId === null && <DraftRow depth={0} />}
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
              onClick={() => setDraft({ kind: 'project', parentId: null })}
            >
              + New project
            </button>
          )}
        </nav>
      </aside>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </Ctx.Provider>
  );
}
