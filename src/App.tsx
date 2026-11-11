import { useEffect } from 'react';
import { ResizeHandles, TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { ProjectOverview } from './components/ProjectOverview';
import { TopicDetail } from './components/TopicDetail';
import { RefineTopicDialog } from './components/RefineTopicDialog';
import { ConfirmDialog, Toasts } from './components/ui';
import { SearchDialog } from './components/SearchDialog';
import { ChartsDialog } from './components/ChartsDialog';
import { DelegationDialog } from './components/DelegationDialog';
import { ComplexityPickerDialog } from './components/ComplexityPickerDialog';
import { AgentsEditor, ChangeFolderDialog, NewProjectDialog } from './components/ProjectFolder';
import { ProjectIconDialog } from './components/ProjectIcon';
import { TerminalPanel } from './components/TerminalPanel';
import { useBishopStore } from './store/useBishopStore';

export default function App() {
  const loadTree = useBishopStore((s) => s.loadTree);
  const setSearchOpen = useBishopStore((s) => s.setSearchOpen);
  const setTerminalOpen = useBishopStore((s) => s.setTerminalOpen);
  const refreshTopics = useBishopStore((s) => s.refreshTopics);
  const refreshActiveTasks = useBishopStore((s) => s.refreshActiveTasks);
  const selectedProjectId = useBishopStore((s) => s.selectedProjectId);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Claude ticks tasks through the API, and its session keeps running while the Terminal is hidden,
  // so pick that up whether or not the panel is open.
  useEffect(() => {
    if (selectedProjectId === null) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      refreshTopics();
      refreshActiveTasks();
    };
    refreshActiveTasks();
    const timer = setInterval(tick, 3000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [selectedProjectId, refreshTopics, refreshActiveTasks]);

  // Ctrl+` toggles the terminal from anywhere. Ctrl+K / Ctrl+F open search (WebView2's own find bar
  // is replaced by ours), but not while the terminal has focus: those keys belong to the program there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Backquote') {
        e.preventDefault();
        setTerminalOpen(!useBishopStore.getState().terminalOpen);
        return;
      }
      if ((document.activeElement as HTMLElement | null)?.closest?.('.xterm')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen, setTerminalOpen]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden border border-[var(--border)] bg-[var(--center-bg)] text-[var(--foreground)]">
      <ResizeHandles />
      <TitleBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          <ProjectOverview />
          <TerminalPanel />
        </main>
      </div>
      <TopicDetail />
      <RefineTopicDialog />
      <SearchDialog />
      <ChartsDialog />
      <DelegationDialog />
      <ComplexityPickerDialog />
      <NewProjectDialog />
      <ChangeFolderDialog />
      <ProjectIconDialog />
      <AgentsEditor />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
