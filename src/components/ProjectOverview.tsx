import { useState } from 'react';
import { Mic, Plus } from 'lucide-react';
import { useBishopStore } from '../store/useBishopStore';
import { CATEGORIES, type Category, type Topic } from '../types';
import { CATEGORY_ACCENTS, CATEGORY_LABELS } from './categories';
import { InlineInput } from './ui';
import { VoiceTopic } from './VoiceTopic';

export function CategorySelect({ value, onChange, className = '' }: { value: Category; onChange: (c: Category) => void; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Category)}
      onClick={(e) => e.stopPropagation()}
      className={`rounded border border-[var(--border)] bg-[var(--sidebar)] text-xs px-1 py-0.5 outline-none focus:border-[var(--primary)] ${className}`}
    >
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {CATEGORY_LABELS[c]}
        </option>
      ))}
    </select>
  );
}

function TopicCard({ topic }: { topic: Topic }) {
  const { openTopic, updateTopic } = useBishopStore();
  const done = topic.tasks.filter((t) => t.completed).length;
  const total = topic.tasks.length;
  const pending = topic.id < 0;

  return (
    <div
      data-testid="topic-card"
      className={`rounded-md border border-[var(--border)] bg-[var(--card)] p-3 cursor-pointer hover:border-[var(--primary)] transition-colors ${
        pending ? 'opacity-60' : ''
      }`}
      onClick={() => !pending && openTopic(topic.id)}
    >
      <div className="text-sm font-medium break-words">{topic.title}</div>
      {topic.description && (
        <div className="mt-1 text-xs text-[var(--muted-foreground)] line-clamp-2 break-words">{topic.description}</div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {total > 0 && (
            <div className="h-1 w-12 min-w-2 shrink rounded bg-[var(--sidebar)] overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${(done / total) * 100}%` }} />
            </div>
          )}
          <span className="shrink-0 text-xs text-[var(--muted-foreground)] tabular-nums">
            {done}/{total}
          </span>
        </div>
        <CategorySelect value={topic.category} onChange={(category) => updateTopic(topic.id, { category })} />
      </div>
    </div>
  );
}

function Column({ category, topics }: { category: Category; topics: Topic[] }) {
  const { createTopic } = useBishopStore();
  const [adding, setAdding] = useState(false);

  return (
    <section
      data-testid={`column-${category}`}
      className={`flex flex-col min-w-0 rounded-lg border border-[var(--border)] border-t-2 ${CATEGORY_ACCENTS[category]} bg-[var(--sidebar)]`}
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {CATEGORY_LABELS[category]} <span className="ml-1 tabular-nums">{topics.length}</span>
        </h2>
        <button className="p-1 rounded hover:bg-[var(--card)]" title="Add topic" onClick={() => setAdding(true)}>
          <Plus size={14} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-2">
        {topics.map((t) => (
          <TopicCard key={t.id} topic={t} />
        ))}
        {adding ? (
          <InlineInput
            placeholder="Topic title"
            onCommit={(title) => {
              setAdding(false);
              createTopic(title, category);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            className="text-left text-xs px-2 py-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={() => setAdding(true)}
          >
            + Add topic
          </button>
        )}
      </div>
    </section>
  );
}

export function ProjectOverview() {
  const { projects, selectedProjectId, topics } = useBishopStore();
  const project = projects.find((p) => p.id === selectedProjectId);
  const [voiceOpen, setVoiceOpen] = useState(false);

  if (!project) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-[var(--muted-foreground)]">Select or create a project.</div>
    );
  }

  const byOrder = (a: Topic, b: Topic) => a.sortOrder - b.sortOrder || a.id - b.id;

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-5 gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold truncate">{project.name}</h1>
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-110"
          title="Record a voice note and turn it into a topic"
          onClick={() => setVoiceOpen(true)}
        >
          <Mic size={15} /> Voice topic
        </button>
      </div>
      {voiceOpen && <VoiceTopic onClose={() => setVoiceOpen(false)} />}
      <div className="flex-1 grid grid-cols-4 gap-3 min-h-0">
        {CATEGORIES.map((cat) => (
          <Column key={cat} category={cat} topics={topics.filter((t) => t.category === cat).sort(byOrder)} />
        ))}
      </div>
    </div>
  );
}
