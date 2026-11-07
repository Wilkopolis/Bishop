import { createContext, useContext, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Folder as FolderIcon, FolderPlus, MoreHorizontal, Plus, Search, Settings } from './icons';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { api } from '../api/client';
import { bySortOrder, useBishopStore } from '../store/useBishopStore';
import type { Folder, Project, QueuedCount, TerminalInfo } from '../types';
import { ProjectIcon } from './ProjectIcon';
import { SessionFeed } from './SessionFeed';
import { ContextMenu, InlineInput, type MenuItem } from './ui';
import { UsageMeter } from './UsageMeter';
import { VoiceTopic } from './VoiceTopic';

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

// Drop target ids: "root", "f<folderId>" (into folder), "p<projectId>" (before that project).
const ROOT = 'root';

function folderPath(folders: Folder[], id: number): string {
  const parts: string[] = [];
  for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f!.parentId)) {
    parts.unshift(f.name);
  }
  return parts.join(' / ');
}

function DraftRow({ depth }: { depth: number }) {
  const { draft, setDraft } = useContext(Ctx);
  const { createFolder } = useBishopStore();
  if (!draft) return null;
  return (
    <div className="py-0.5 pr-2" style={indent(depth)}>
      <InlineInput
        placeholder={draft.kind === 'project' ? 'Project name' : 'Folder name'}
        onCommit={(name) => {
          setDraft(null);
          createFolder(name, draft.parentId);
        }}
        onCancel={() => setDraft(null)}
      />
    </div>
  );
}

/**
 * The faint text beside a project's name: its work state. Null shows nothing: the sessions haven't loaded yet.
 * Running matches the host's `IsBusy`: Claude is on a task, or someone is working in the project's Terminal. Idle is the opposite.
 * A session left in the background or never typed in doesn't count.
 * Queued tasks replace idle, and sit beside running so the count isn't lost while the queue is moving.
 */
const projectStatus = (project: Project, sessions: TerminalInfo[] | null, queuedCounts: QueuedCount[]): string | null => {
  if (sessions === null) return null;
  const busy = sessions.some((t) => t.projectId === project.id && t.alive && (t.taskRunning || (t.used && !t.background)));
  const queued = queuedCounts.find((q) => q.projectId === project.id)?.count ?? 0;
  if (busy) return queued > 0 ? `running, ${queued} queued` : 'running';
  if (queued > 0) return `${queued} ${queued === 1 ? 'task' : 'tasks'} queued`;
  return 'idle';
};

function ProjectRow({ project, depth }: { project: Project; depth: number }) {
  const { selectedProjectId, selectProject, renameProject, moveProject, deleteProject, folders, confirm, setEditingTagline, setFolderDialogFor, setIconDialogFor, pushError, sessions, queuedCounts } =
    useBishopStore();
  // A topic from the board is being dragged over this row: dropping moves it into this project.
  const topicOver = useBishopStore((s) => s.topicDropProjectId === project.id);
  const { editing, setEditing, openMenu } = useContext(Ctx);
  const selected = selectedProjectId === project.id;
  const drag = useDraggable({ id: `p${project.id}` });
  const drop = useDroppable({ id: `p${project.id}` });

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
      label: project.tagline ? 'Edit tagline' : 'Add tagline',
      onSelect: async () => {
        if (selectedProjectId !== project.id) await selectProject(project.id);
        setEditingTagline(true);
      },
    },
    { label: 'Change icon…', onSelect: () => setIconDialogFor(project.id) },
    { label: project.folderPath ? 'Change folder…' : 'Choose folder…', onSelect: () => setFolderDialogFor(project.id) },
    ...(project.folderPath && !project.folderMissing
      ? [{ label: 'Open folder', onSelect: () => api.openProjectFolder(project.id).catch(pushError) }]
      : []),
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
      onSelect: async () => {
        const folderNote = project.folderPath ? ` Its folder on disk (${project.folderPath}) is not touched.` : '';
        if (await confirm({ title: 'Delete project?', message: `"${project.name}" will be removed from Bishop. Its Bishop data file is kept in the trash folder.${folderNote}` }))
          deleteProject(project.id);
      },
    },
  ];

  const dropping = drop.isOver && !drag.isDragging;
  const status = projectStatus(project, sessions, queuedCounts);

  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.attributes}
      {...drag.listeners}
      data-project-id={project.id}
      aria-label={`${project.name}${status ? `, ${status}` : ''}. Press Space to pick up and move with arrow keys.`}
      className={`group relative flex items-center gap-2 pr-1 py-1 rounded cursor-pointer text-sm ${
        selected ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'hover:bg-[var(--card)]'
      } ${drag.isDragging ? 'opacity-40' : ''} ${topicOver ? 'ring-1 ring-[var(--primary)] bg-[var(--primary-subtle)]' : ''}`}
      style={indent(depth)}
      onClick={() => selectProject(project.id)}
      onDoubleClick={() => setEditing({ kind: 'project', id: project.id })}
      onContextMenu={(e) => openMenu(e, menu)}
    >
      {dropping && <div className="absolute left-1 right-1 -top-px h-0.5 rounded bg-[var(--primary)]" />}
      <ProjectIcon project={project} plain={selected} />
      <span className="truncate flex-1">{project.name}</span>
      {status && <span className="shrink-0 text-xs opacity-60">{status}</span>}
      <button
        className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100"
        title="Project actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); openMenu(e, menu); }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

function FolderNode({ folder, depth }: { folder: Folder; depth: number }) {
  const { folders, projects, renameFolder, deleteFolder, confirm, setNewProjectDialog } = useBishopStore();
  const { editing, setEditing, draft, setDraft, openMenu } = useContext(Ctx);
  const drop = useDroppable({ id: `f${folder.id}` });

  const menu: MenuItem[] = [
    { label: 'New project here', onSelect: () => setNewProjectDialog({ folderId: folder.id }) },
    { label: 'New subfolder', onSelect: () => setDraft({ kind: 'folder', parentId: folder.id }) },
    { label: 'Rename', onSelect: () => setEditing({ kind: 'folder', id: folder.id }) },
    {
      label: 'Delete folder',
      danger: true,
      onSelect: async () => {
        if (await confirm({ title: 'Delete folder?', message: `"${folder.name}" will be deleted. Its projects and subfolders move up one level.` }))
          deleteFolder(folder.id);
      },
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
          ref={drop.setNodeRef}
          data-folder-id={folder.id}
          className={`group flex items-center gap-2 pr-1 py-1 rounded text-xs uppercase tracking-wide text-[var(--muted-foreground)] hover:bg-[var(--card)] ${
            drop.isOver ? 'ring-1 ring-[var(--primary)] bg-[var(--card)] text-[var(--foreground)]' : ''
          }`}
          style={indent(depth)}
          onDoubleClick={() => setEditing({ kind: 'folder', id: folder.id })}
          onContextMenu={(e) => openMenu(e, menu)}
        >
          <FolderIcon size={13} className="shrink-0" />
          <span className="truncate flex-1">{folder.name}</span>
          <button className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100" title="Folder actions" onClick={(e) => openMenu(e, menu)}>
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
        .sort(bySortOrder)
        .map((p) => (
          <ProjectRow key={`p${p.id}`} project={p} depth={depth + 1} />
        ))}
      {draft?.parentId === folder.id && <DraftRow depth={depth + 1} />}
    </div>
  );
}

/** Empty strip under the tree: dropping here moves a project to the root, at the end. */
function RootDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: ROOT });
  return (
    <div
      ref={setNodeRef}
      data-testid="root-drop"
      className={`flex-1 min-h-8 mt-1 rounded text-xs grid place-items-start px-2 pt-1 ${
        isOver ? 'ring-1 ring-[var(--primary)] text-[var(--muted-foreground)]' : 'text-transparent'
      }`}
    >
      Move out of folder
    </div>
  );
}

// Prefer whatever is under the pointer; fall back to rect overlap for keyboard drags.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

export function Sidebar() {
  const { folders, projects, loading, placeProject, setSearchOpen, pushError, pushInfo, setNewProjectDialog } = useBishopStore();
  const [editing, setEditing] = useState<Ref | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dragging, setDragging] = useState<Project | null>(null);

  const asideRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [sessionMaxHeight, setSessionMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const update = () => {
      const aside = asideRef.current;
      if (!aside) return;

      const asideHeight = aside.clientHeight;
      const headerHeight = headerRef.current?.offsetHeight ?? 0;
      const treeHeight = treeRef.current?.offsetHeight ?? 0;
      const dropZoneMinHeight = projects.length > 0 ? 36 : 0;
      const navPaddingBottom = 8;
      const navNeededHeight = treeHeight + dropZoneMinHeight + navPaddingBottom;
      const bottomHeight = bottomRef.current?.offsetHeight ?? 0;

      const available = asideHeight - headerHeight - navNeededHeight - bottomHeight;
      setSessionMaxHeight(Math.max(0, Math.floor(available)));
    };

    update();

    const ro = new ResizeObserver(update);
    if (asideRef.current) ro.observe(asideRef.current);
    if (headerRef.current) ro.observe(headerRef.current);
    if (treeRef.current) ro.observe(treeRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);

    return () => ro.disconnect();
  }, [projects.length, folders.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } }),
  );

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openSettings = async (e: MouseEvent) => {
    const anchor = { clientX: e.clientX, clientY: e.clientY };
    let info = 'No backups yet';
    try {
      const { backups, keep } = await api.listBackups();
      if (backups.length > 0) info = `Last backup ${new Date(backups[0].createdAt).toLocaleString()} · ${backups.length}/${keep} kept`;
    } catch {}
    setMenu({
      x: anchor.clientX,
      y: anchor.clientY,
      items: [
        {
          label: 'Back up now',
          onSelect: async () => {
            try {
              const b = await api.backupNow();
              pushInfo(`Backup saved: ${b.name}`);
            } catch (err) {
              pushError(err);
            }
          },
        },
        { label: 'Open backups folder', onSelect: () => api.openBackupsFolder().catch(pushError) },
        { label: info, disabled: true },
      ],
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const id = Number(String(active.id).slice(1));
    const target = String(over.id);
    if (target === ROOT) placeProject(id, null, null);
    else if (target.startsWith('f')) placeProject(id, Number(target.slice(1)), null);
    else if (target.startsWith('p')) {
      const before = projects.find((p) => p.id === Number(target.slice(1)));
      if (before && before.id !== id) placeProject(id, before.folderId, before.id);
    }
  };

  return (
    <Ctx.Provider value={{ editing, setEditing, draft, setDraft, openMenu }}>
      <aside ref={asideRef} className="w-64 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
        <div ref={headerRef} className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Projects</span>
          <div className="flex gap-1">
            <button className="p-1 rounded hover:bg-[var(--card)]" title="Search (Ctrl+K)" onClick={() => setSearchOpen(true)}>
              <Search size={15} />
            </button>
            <button className="p-1 rounded hover:bg-[var(--card)]" title="New folder" onClick={() => setDraft({ kind: 'folder', parentId: null })}>
              <FolderPlus size={15} />
            </button>
            <button className="p-1 rounded hover:bg-[var(--card)]" title="New project" onClick={() => setNewProjectDialog({ folderId: null })}>
              <Plus size={15} />
            </button>
            <button className="p-1 rounded hover:bg-[var(--card)]" title="Settings & backups" onClick={openSettings}>
              <Settings size={15} />
            </button>
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={({ active }) => setDragging(projects.find((p) => `p${p.id}` === active.id) ?? null)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <nav data-projects-panel className="flex-1 flex flex-col overflow-y-auto px-1 pb-2">
            <div ref={treeRef} className="flex flex-col">
              {draft?.parentId === null && <DraftRow depth={0} />}
              {folders
                .filter((f) => f.parentId === null)
                .map((f) => (
                  <FolderNode key={`f${f.id}`} folder={f} depth={0} />
                ))}
              {projects
                .filter((p) => p.folderId === null)
                .sort(bySortOrder)
                .map((p) => (
                  <ProjectRow key={`p${p.id}`} project={p} depth={0} />
                ))}
              {!loading && folders.length === 0 && projects.length === 0 && !draft && (
                <button
                  className="w-full mt-4 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  onClick={() => setNewProjectDialog({ folderId: null })}
                >
                  + New project
                </button>
              )}
            </div>
            {projects.length > 0 && <RootDropZone />}
          </nav>
          <DragOverlay>
            {dragging && (
              <div className="flex items-center gap-2 px-2 py-1 rounded text-sm bg-[var(--card)] border border-[var(--primary)] shadow-xl">
                <ProjectIcon project={dragging} /> {dragging.name}
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <SessionFeed maxHeight={sessionMaxHeight} />
        <div ref={bottomRef} className="shrink-0 flex flex-col">
          <UsageMeter />
          <VoiceTopic />
        </div>
      </aside>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </Ctx.Provider>
  );
}
