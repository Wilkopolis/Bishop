import { useEffect } from 'react';
import { ResizeHandles, TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { ProjectOverview } from './components/ProjectOverview';
import { TopicDetail } from './components/TopicDetail';
import { Toasts } from './components/ui';
import { useBishopStore } from './store/useBishopStore';

export default function App() {
  const loadTree = useBishopStore((s) => s.loadTree);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden border border-[var(--border)] bg-[var(--center-bg)] text-[var(--foreground)]">
      <ResizeHandles />
      <TitleBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          <ProjectOverview />
        </main>
      </div>
      <TopicDetail />
      <Toasts />
    </div>
  );
}
