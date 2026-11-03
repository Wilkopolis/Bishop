import { useEffect } from 'react';
import { ResizeHandles, TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { useBishopStore } from './store/useBishopStore';
import { CATEGORIES, type Category } from './types';

const CATEGORY_LABELS: Record<Category, string> = {
  RIGHT_NOW: 'Right now',
  SOON: 'Soon',
  LATER: 'Later',
  BACKLOG: 'Backlog',
};

// Placeholder main pane: read-only view of the selected project's topics by category.
function MainPane() {
  const { projects, selectedProjectId, topics } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);

  if (!project) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-[var(--muted-foreground)]">
        Select or create a project.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold mb-4">{project.name}</h1>
      <div className="grid grid-cols-4 gap-4">
        {CATEGORIES.map((cat) => {
          const inCat = topics.filter((t) => t.category === cat);
          return (
            <section key={cat} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 min-h-32">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-2">
                {CATEGORY_LABELS[cat]} · {inCat.length}
              </h2>
              {inCat.map((t) => (
                <div key={t.id} className="text-sm py-1">
                  {t.title}{' '}
                  <span className="text-[var(--muted-foreground)]">
                    ({t.tasks.filter((k) => k.completed).length}/{t.tasks.length})
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const { loadTree, error, clearError } = useBishopStore();

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
          {error && (
            <div className="px-4 py-2 text-sm bg-red-900/40 text-red-200 flex justify-between">
              <span>{error}</span>
              <button onClick={clearError}>Dismiss</button>
            </div>
          )}
          <MainPane />
        </main>
      </div>
    </div>
  );
}
