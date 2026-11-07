import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from './icons';
import { api } from '../api/client';
import { useBishopStore } from '../store/useBishopStore';
import type { SearchHit } from '../types';

const MATCH_LABELS: Record<SearchHit['matchKind'], string> = { title: 'Title', description: 'Description', task: 'Task' };

/** Ctrl+K / Ctrl+F search across topic titles, descriptions and task titles in every project. */
export function SearchDialog() {
  const { searchOpen, setSearchOpen, selectedProjectId, selectProject, openTopic, pushError } = useBishopStore();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!searchOpen) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const result = await api.search(q);
        if (alive) {
          setHits(result);
          setActive(0);
        }
      } catch (e) {
        if (alive) pushError(e);
      } finally {
        if (alive) setLoading(false);
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, searchOpen]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!searchOpen) return null;

  const close = () => setSearchOpen(false);
  const choose = async (hit: SearchHit) => {
    close();
    if (selectedProjectId !== hit.projectId) await selectProject(hit.projectId);
    openTopic(hit.topicId);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-start pt-[12vh] px-6" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Search"
        data-testid="search-dialog"
        className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[var(--border)]">
          {loading ? <Loader2 size={16} className="animate-spin shrink-0" /> : <Search size={16} className="shrink-0 text-[var(--muted-foreground)]" />}
          <input
            autoFocus
            aria-label="Search topics and tasks"
            className="flex-1 py-3 bg-transparent outline-none text-sm select-text"
            placeholder="Search topics and tasks in all projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && hits[active]) choose(hits[active]);
            }}
          />
          <kbd className="text-[10px] text-[var(--muted-foreground)] border border-[var(--border)] rounded px-1">Esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {hits.map((hit, i) => (
            <li
              key={`${hit.projectId}-${hit.topicId}`}
              data-index={i}
              data-testid="search-hit"
              className={`px-3 py-2 cursor-pointer border-b border-[var(--border)]/50 ${i === active ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'hover:bg-[var(--card)]'}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(hit)}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium truncate">{hit.topicTitle}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider opacity-80">{hit.archived ? 'Archived' : hit.categoryName}</span>
              </div>
              <div className="flex items-center gap-2 text-xs opacity-75">
                <span className="shrink-0">{hit.projectName}</span>
                {hit.matchKind !== 'title' && (
                  <span className="truncate">
                    · {MATCH_LABELS[hit.matchKind]}: {hit.snippet}
                  </span>
                )}
              </div>
            </li>
          ))}
          {query.trim() && !loading && hits.length === 0 && <li className="px-3 py-4 text-sm text-[var(--muted-foreground)]">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
