import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Download, FileAudio, Loader2, Mic, Plus, Sparkles, Stop, WarningCircle, X } from './icons';
import { api } from '../api/client';
import { startRecording, toWav16k, type Recording } from '../audio/recorder';
import { useBishopStore } from '../store/useBishopStore';
import { clampComplexity, complexityColor, complexityTextColor, COMPLEXITY_COLORS, rateTaskComplexity, type TopicDraft, type TopicResearch, type Transcription, type VoiceStatus, type WhisperStatus } from '../types';
import { CategorySelect } from './ProjectOverview';
import { Modal } from './ui';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'model' }
  | { kind: 'transcript' }
  | { kind: 'generating' }
  | { kind: 'review' }
  | { kind: 'saving'; draftId: number; all?: boolean };

/** A draft under review. The id keeps each card's own state when another card leaves the dialog. `researchStale` means it was edited since the last research. */
type ReviewDraft = TopicDraft & { id: number; researching?: boolean; research?: TopicResearch; researchStale?: boolean };

/** What actually gets saved: trimmed, without blank tasks. */
const cleanDraft = (draft: ReviewDraft): TopicDraft => {
  const tasks: string[] = [];
  const taskComplexities: number[] = [];
  const taskUserActions: boolean[] = [];
  draft.tasks.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    tasks.push(trimmed);
    const rated = draft.taskComplexities?.[i];
    taskComplexities.push(rated !== undefined ? clampComplexity(rated) : rateTaskComplexity(trimmed));
    taskUserActions.push(draft.taskUserActions?.[i] === true);
  });
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    category: draft.category,
    tasks,
    taskComplexities,
    taskUserActions,
  };
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const modelReady = (s: VoiceStatus) => s.whisper.state === 'ready' || s.whisper.state === 'loaded';

const WAVE_INTERVAL_MS = 50;
const WAVE_BAR = 2;
const WAVE_STEP = 4;
const DURATION_INTERVAL_MS = 250;

const round = 'w-9 h-9 shrink-0 rounded-full grid place-items-center';
const roundPrimary = `${round} bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:pointer-events-none`;
const btn = 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-50';
const primary = `${btn} bg-[var(--primary)] text-[var(--primary-foreground)]`;
const secondary = `${btn} border border-[var(--border)] hover:bg-[var(--card)]`;
const field = 'w-full px-2 py-1.5 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text';

function ModelPrompt({ whisper: w, onDownload }: { whisper: WhisperStatus; onDownload: () => void }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span>
        Voice topics need the Whisper <b>{w.model}</b> speech model (downloaded once, about 1.6 GB, stored in{' '}
        <code className="text-xs">{w.modelPath}</code>).
      </span>
      {w.error && <span className="text-red-400">{w.error}</span>}
      <div>
        <button className={primary} onClick={onDownload}>
          <Download size={14} /> Download model
        </button>
      </div>
    </div>
  );
}

/** Takes over the strip while the model downloads. The bar pulses until the size is known. */
function ModelProgress({ whisper: w }: { whisper: WhisperStatus }) {
  const pct = w.totalBytes ? (w.downloadedBytes / w.totalBytes) * 100 : null;
  return (
    <div
      className="flex-1 min-w-0 flex flex-col gap-1.5"
      role="progressbar"
      aria-label="Downloading speech model"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(pct)}
      title={`Downloading the Whisper ${w.model} speech model`}
    >
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">Downloading model</span>
        <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">
          {mb(w.downloadedBytes)}
          {w.totalBytes ? ` / ${mb(w.totalBytes)}` : ''} MB
        </span>
      </div>
      <div className="h-1.5 rounded bg-[var(--card)] overflow-hidden">
        <div
          className={`h-full bg-[var(--primary)] transition-[width] ${pct === null ? 'animate-pulse' : ''}`}
          style={{ width: `${pct ?? 100}%` }}
        />
      </div>
    </div>
  );
}

/** Scrolling bars of the microphone level, newest on the right. Drawn on a canvas so it doesn't re-render the strip. */
function Waveform({ recording }: { recording: RefObject<Recording | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const color = getComputedStyle(el).getPropertyValue('--primary');
    const levels: number[] = [];
    let last = 0;
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < WAVE_INTERVAL_MS) return;
      last = now;

      const { clientWidth: w, clientHeight: h } = el;
      const dpr = window.devicePixelRatio;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      levels.push(recording.current?.level() ?? 0);
      const count = Math.ceil(w / WAVE_STEP);
      if (levels.length > count) levels.splice(0, levels.length - count);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      levels.forEach((level, i) => {
        const bar = Math.max(WAVE_BAR, level * h);
        ctx.fillRect(w - (levels.length - i) * WAVE_STEP, (h - bar) / 2, WAVE_BAR, bar);
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [recording]);

  return <canvas ref={canvas} data-testid="voice-waveform" className="flex-1 min-w-0 h-7" role="img" aria-label="Recording, live microphone level" />;
}

/** Time recorded so far, as m:ss. Holds its own state so only this text re-renders each second. */
function Duration({ recording }: { recording: RefObject<Recording | null> }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((recording.current?.elapsedMs() ?? 0) / 1000)), DURATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [recording]);

  return (
    <span data-testid="voice-duration" className="shrink-0 text-xs tabular-nums text-[var(--muted-foreground)]" role="timer" aria-label="Recording duration">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

function ResearchList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1">{title}</div>
      <ul className="flex flex-col gap-1 list-disc pl-4 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** Claude's verdict on a draft, what's missing, and what it needs the user to answer. */
function ResearchResult({ research, stale }: { research: TopicResearch; stale?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);

  // On a tall card the result lands under the sticky buttons, so bring it into view. The margin clears them.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <div
      ref={panel}
      data-testid="voice-research"
      className="flex flex-col gap-2 p-2.5 rounded border border-[var(--border)] bg-[var(--card)] scroll-mb-16 select-text"
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        {research.sufficient ? <Check size={14} className="shrink-0" /> : <WarningCircle size={14} className="shrink-0 text-[var(--primary-text)]" />}
        {research.sufficient ? 'These tasks look sufficient' : 'These tasks have gaps'}
      </div>
      {research.summary && <p className="text-sm text-[var(--muted-foreground)]">{research.summary}</p>}
      <ResearchList title="Missing" items={research.missing} />
      <ResearchList title="Questions for you" items={research.questions} />
      {research.userActions && research.userActions.length > 0 && (
        <ResearchList title="Requires user action" items={research.userActions} />
      )}
      {stale && <p className="text-xs text-[var(--muted-foreground)]">You edited this topic after this check. Click Research to check it again.</p>}
    </div>
  );
}

/** One proposed topic in the review dialog. It saves or discards on its own, so the others stay open. */
function DraftCard({
  draft,
  onChange,
  onSave,
  onDiscard,
  onResearch,
  disabled,
  saving,
}: {
  draft: ReviewDraft;
  onChange: (next: ReviewDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
  onResearch: () => void;
  disabled: boolean;
  saving: boolean;
}) {
  return (
    <div data-testid="voice-draft" className="min-w-0 flex flex-col gap-3 p-3 rounded-lg border border-[var(--border)]">
      {/* Locks the whole card while saving or researching, so an edit can't land after its draft was already sent. */}
      <fieldset className="contents" disabled={disabled || draft.researching}>
        <input
          aria-label="Draft title"
          className={`${field} text-base font-semibold`}
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          Category
          <CategorySelect value={draft.category} onChange={(category) => onChange({ ...draft, category })} className="text-sm" />
        </div>
        <textarea
          aria-label="Draft description"
          className={`${field} min-h-20 resize-y`}
          placeholder="Description"
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Tasks</div>
          <ul className="flex flex-col gap-1">
            {draft.tasks.map((t, i) => {
              const complexity = clampComplexity(draft.taskComplexities?.[i] ?? rateTaskComplexity(t));
              return (
                <li key={i} className="grid grid-cols-[minmax(0,1fr)_2.75rem_1.75rem] items-center gap-2 w-full">
                  <input
                    aria-label={`Draft task ${i + 1}`}
                    className={`${field} min-w-0 w-full truncate`}
                    value={t}
                    onChange={(e) => {
                      const nextTitle = e.target.value;
                      const currentComplexities = draft.tasks.map((x, j) => draft.taskComplexities?.[j] ?? rateTaskComplexity(x));
                      currentComplexities[i] = rateTaskComplexity(nextTitle);
                      onChange({
                        ...draft,
                        tasks: draft.tasks.map((x, j) => (j === i ? nextTitle : x)),
                        taskComplexities: currentComplexities,
                      });
                    }}
                  />
                  <span
                    data-testid="draft-task-complexity"
                    data-complexity={complexity}
                    data-complexity-color={COMPLEXITY_COLORS[complexity]}
                    title={`Complexity ${complexity}/10`}
                    aria-label={`Complexity ${complexity} of 10`}
                    style={{ backgroundColor: complexityColor(complexity), color: complexityTextColor(complexity) }}
                    className="w-full px-1.5 py-1 rounded text-center text-xs font-semibold tabular-nums"
                  >
                    {complexity}/10
                  </span>
                  <button
                    className="flex items-center justify-center justify-self-end p-1 rounded hover:text-red-400"
                    title="Remove task"
                    onClick={() => {
                      const currentComplexities = draft.tasks.map((x, j) => draft.taskComplexities?.[j] ?? rateTaskComplexity(x));
                      onChange({
                        ...draft,
                        tasks: draft.tasks.filter((_, j) => j !== i),
                        taskComplexities: currentComplexities.filter((_, j) => j !== i),
                        taskUserActions: draft.tasks.map((_, j) => draft.taskUserActions?.[j] === true).filter((_, j) => j !== i),
                      });
                    }}
                  >
                    <X size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            className="mt-1 flex items-center gap-1 text-xs px-2 py-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={() => {
              const currentComplexities = draft.tasks.map((x, j) => draft.taskComplexities?.[j] ?? rateTaskComplexity(x));
              onChange({
                ...draft,
                tasks: [...draft.tasks, ''],
                taskComplexities: [...currentComplexities, 3],
                taskUserActions: [...draft.tasks.map((_, j) => draft.taskUserActions?.[j] === true), false],
              });
            }}
          >
            <Plus size={12} /> Add task
          </button>
        </div>
        {draft.research && <ResearchResult research={draft.research} stale={draft.researchStale} />}
        {/* Sticks to the bottom of the scrolling area, so a tall card still shows its buttons. */}
        <div className="sticky bottom-0 mt-auto flex flex-wrap justify-between gap-2 border-t border-[var(--border)] bg-[var(--sidebar)] pt-3">
          <button className={secondary} onClick={onDiscard}>
            Discard
          </button>
          <div className="flex gap-2">
            <button className={secondary} title="Have Claude check whether these tasks are enough for this topic and whether you need to answer anything" onClick={onResearch}>
              {draft.researching ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
              {draft.researching ? 'Researching…' : 'Research'}
            </button>
            <button className={primary} onClick={onSave}>
              {saving && <Loader2 className="animate-spin" size={14} />} Save topic
            </button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}

/** Fixed strip at the bottom left of the sidebar. Recording and the model download happen here; a dialog opens only to offer the download and to review the result. */
export function VoiceTopic() {
  const { selectedProjectId, projects, saveTopicDraft, pushError } = useBishopStore();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [stats, setStats] = useState<Transcription | null>(null);
  // One draft per unrelated request in the note. The dialog shows them side by side.
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  // Importing the note again would draft the saved topics a second time, so saving closes the way back.
  const [savedSome, setSavedSome] = useState(false);
  const recording = useRef<Recording | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const downloading = status?.whisper.state === 'downloading';

  // The download runs in the host, so it may already be going when the app opens.
  useEffect(() => {
    api.voiceStatus().then(setStatus, () => {});
  }, []);

  // Poll for progress while the model downloads, whichever way it started.
  useEffect(() => {
    if (!downloading) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await api.voiceStatus();
        if (!alive) return;
        setStatus(s);
        if (s.whisper.state === 'downloading') timer = window.setTimeout(tick, 500);
        else if (s.whisper.error) pushError(s.whisper.error);
      } catch {
        // Keep trying: stopping here would leave the strip stuck on the last progress.
        if (alive) timer = window.setTimeout(tick, 2000);
      }
    };
    timer = window.setTimeout(tick, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [downloading, pushError]);

  // Never leave the mic open.
  useEffect(() => () => recording.current?.cancel(), []);

  const download = async () => {
    setError(null);
    try {
      setStatus(await api.downloadModel());
      setPhase({ kind: 'idle' });
    } catch (e) {
      setError(message(e));
    }
  };

  /** True when Whisper can run. Otherwise offers the download, unless it's already running. */
  const ensureModel = async () => {
    const s = await api.voiceStatus();
    setStatus(s);
    if (modelReady(s)) return true;
    setError(null);
    setPhase({ kind: s.whisper.state === 'downloading' ? 'idle' : 'model' });
    return false;
  };

  const transcribe = async (wav: Blob) => {
    setPhase({ kind: 'transcribing' });
    try {
      const result = await api.transcribe(wav);
      setStats(result);
      setTranscript(result.text);
      setError(null);
      setPhase({ kind: 'transcript' });
      api.voiceStatus().then(setStatus, () => {});
    } catch (e) {
      pushError(e);
      setPhase({ kind: 'idle' });
    }
  };

  const record = async () => {
    setPhase({ kind: 'starting' });
    try {
      if (!(await ensureModel())) return;
      recording.current = await startRecording();
      setPhase({ kind: 'recording' });
    } catch (e) {
      pushError(e);
      setPhase({ kind: 'idle' });
    }
  };

  const stop = async () => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    setPhase({ kind: 'transcribing' });
    try {
      await transcribe(await rec.stop());
    } catch (e) {
      pushError(e);
      setPhase({ kind: 'idle' });
    }
  };

  const cancel = () => {
    recording.current?.cancel();
    recording.current = null;
    setPhase({ kind: 'idle' });
  };

  const pickFile = async () => {
    setPhase({ kind: 'starting' });
    try {
      if (!(await ensureModel())) return;
      setPhase({ kind: 'idle' });
      fileInput.current?.click();
    } catch (e) {
      pushError(e);
      setPhase({ kind: 'idle' });
    }
  };

  const fromFile = async (file: File) => {
    setPhase({ kind: 'transcribing' });
    try {
      await transcribe(await toWav16k(file));
    } catch (e) {
      pushError(`Couldn't read that audio file: ${message(e)}`);
      setPhase({ kind: 'idle' });
    }
  };

  /** Opens the transcript dialog empty. Claude does the rest, so this doesn't need the Whisper model. */
  const pasteText = () => setPhase({ kind: 'transcript' });

  const generate = async () => {
    if (selectedProjectId === null) return;
    setError(null);
    setPhase({ kind: 'generating' });
    try {
      const topics = await api.topicFromTranscript(selectedProjectId, transcript);
      setDrafts(topics.map((topic, id) => ({ ...topic, id })));
      setPhase({ kind: 'review' });
    } catch (e) {
      setError(message(e));
      setPhase({ kind: 'transcript' });
    }
  };

  const save = async (draft: ReviewDraft) => {
    const clean = cleanDraft(draft);
    if (!clean.title) return setError('The topic needs a title.');
    setPhase({ kind: 'saving', draftId: draft.id });
    if (await saveTopicDraft(clean)) {
      setSavedSome(true);
      removeDraft(draft.id);
    } else setPhase({ kind: 'review' });
  };

  /** Asks Claude about one draft. Updates by id, since other cards can change while it runs. */
  const research = async (draft: ReviewDraft) => {
    if (selectedProjectId === null) return;
    const clean = cleanDraft(draft);
    if (!clean.title) return setError('The topic needs a title.');
    const update = (fields: Partial<ReviewDraft>) => setDrafts((all) => all.map((d) => (d.id === draft.id ? { ...d, ...fields } : d)));
    setError(null);
    update({ researching: true, research: undefined, researchStale: false });
    try {
      update({ researching: false, research: await api.researchTopic(selectedProjectId, clean) });
    } catch (e) {
      update({ researching: false });
      setError(message(e));
    }
  };

  /** Saves the drafts in order. Each one leaves as it saves, so a failure keeps only the unsaved ones and retrying can't duplicate a topic. */
  const saveAll = async () => {
    if (drafts.some((d) => !d.title.trim())) return setError('Every topic needs a title. Add one or discard that draft.');
    setError(null);
    let saved = 0;
    for (const draft of drafts) {
      setPhase({ kind: 'saving', draftId: draft.id, all: true });
      if (!(await saveTopicDraft(cleanDraft(draft)))) {
        if (saved) setError(`Saved ${saved} of ${drafts.length} topics. The rest are still here to try again.`);
        return setPhase({ kind: 'review' });
      }
      saved++;
      setSavedSome(true);
      setDrafts((left) => left.filter((d) => d.id !== draft.id));
    }
    close();
  };

  /** Takes a saved or discarded draft out of the dialog. The last one closes it. */
  const removeDraft = (id: number) => {
    if (drafts.length < 2) return close();
    setError(null);
    // Functional, because a research result can land while a save is waiting.
    setDrafts((left) => left.filter((d) => d.id !== id));
    setPhase({ kind: 'review' });
  };

  /** Closes the dialog and returns the strip to idle. */
  const close = () => {
    setError(null);
    setTranscript('');
    setStats(null);
    setDrafts([]);
    setSavedSome(false);
    setPhase({ kind: 'idle' });
  };

  // A result landing after the drafts were replaced would match a new card with the same id, so research holds the ways out.
  const researching = drafts.some((d) => d.researching);
  const busy = phase.kind === 'generating' || phase.kind === 'saving' || researching;
  const dialogOpen = phase.kind === 'model' || phase.kind === 'transcript' || phase.kind === 'review' || busy;
  const noProject = selectedProjectId === null;
  // Only a transcription sets stats, so without them the text was pasted or typed.
  const pasted = !stats && phase.kind !== 'model';
  const projectName = projects.find((p) => p.id === selectedProjectId)?.name;
  const reviewing = phase.kind === 'review' || phase.kind === 'saving';
  // Room for every card side by side. Past the window's width the cards scroll sideways.
  const dialogWidth = reviewing && drafts.length > 1 ? `${drafts.length * 26 + 2.5}rem` : undefined;

  return (
    <>
      <div data-testid="voice-record" className="shrink-0 h-[53px] flex items-center gap-2 px-3 border-t border-[var(--border)]">
        {downloading && status ? (
          <ModelProgress whisper={status.whisper} />
        ) : phase.kind === 'recording' ? (
          <>
            <button className={`${round} bg-red-600 text-white animate-pulse`} title="Stop recording and transcribe" aria-label="Stop recording" onClick={stop}>
              <Stop size={16} />
            </button>
            <Waveform recording={recording} />
            <Duration recording={recording} />
            <button className="p-1 rounded hover:bg-[var(--card)]" title="Discard this recording" aria-label="Discard recording" onClick={cancel}>
              <X size={15} />
            </button>
          </>
        ) : phase.kind === 'transcribing' ? (
          <span className="flex items-center gap-2 min-w-0 text-sm text-[var(--muted-foreground)]">
            <Loader2 className="animate-spin shrink-0" size={16} />
            <span className="truncate">Transcribing on {status?.whisper.backend ?? 'GPU'}…</span>
          </span>
        ) : (
          <>
            <button
              className={roundPrimary}
              title={noProject ? 'Select a project to record a Voice topic' : 'Record a voice note and turn it into a topic'}
              aria-label="Voice topic"
              disabled={noProject || phase.kind === 'starting'}
              onClick={record}
            >
              {phase.kind === 'starting' ? <Loader2 className="animate-spin" size={18} /> : <Mic size={18} />}
            </button>
            {phase.kind !== 'starting' && (
              <button
                className={roundPrimary}
                title={noProject ? 'Select a project to paste text for a Voice topic' : 'Paste text and turn it into a topic'}
                aria-label="Paste text"
                disabled={noProject}
                onClick={pasteText}
              >
                <Plus size={18} />
              </button>
            )}
            <button
              className="ml-auto p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:pointer-events-none"
              title="Transcribe an audio file"
              aria-label="Transcribe an audio file"
              disabled={noProject || phase.kind === 'starting'}
              onClick={pickFile}
            >
              <FileAudio size={15} />
            </button>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,video/webm"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) fromFile(f);
          }}
        />
      </div>

      {dialogOpen && (
        // A transcript can appear while you're busy elsewhere, so only the buttons here discard it, not Escape or a click outside.
        <Modal onClose={phase.kind === 'model' ? close : () => {}} maxWidth={dialogWidth}>
          <div data-testid="voice-topic" className={`p-5 flex flex-col gap-4 ${reviewing ? 'min-h-0' : ''}`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2 min-w-0">
                {pasted ? <Plus size={18} className="shrink-0" /> : <Mic size={18} className="shrink-0" />}{' '}
                <span className="truncate">
                  New topic from {pasted ? 'text' : 'voice'}
                  {projectName && ` in ${projectName}`}
                </span>
              </h2>
              <button className="p-1 rounded hover:bg-[var(--card)] disabled:opacity-40" title="Close" onClick={close} disabled={busy}>
                <X size={16} />
              </button>
            </div>

            {error && <div className="px-3 py-2 rounded border border-red-800 bg-red-950/60 text-sm text-red-200 select-text">{error}</div>}

            {phase.kind === 'model' && status && <ModelPrompt whisper={status.whisper} onDownload={download} />}

            {(phase.kind === 'transcript' || phase.kind === 'generating') && (
              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{pasted ? 'Text' : 'Transcript'}</label>
                <textarea
                  aria-label="Transcript"
                  className={`${field} min-h-32 resize-y`}
                  placeholder={pasted ? 'Paste or type your text here' : undefined}
                  autoFocus={pasted}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  disabled={phase.kind === 'generating'}
                />
                {stats && (
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {stats.audioSeconds.toFixed(1)}s of audio transcribed in {(stats.elapsedMs / 1000).toFixed(1)}s on {stats.backend}
                    {stats.loadMs > 0 && ` (model load ${(stats.loadMs / 1000).toFixed(1)}s)`}
                  </span>
                )}
                <div className="flex justify-between gap-2 pt-1">
                  <button className={secondary} onClick={close} disabled={phase.kind === 'generating'}>
                    {pasted ? (
                      'Cancel'
                    ) : (
                      <>
                        <Mic size={14} /> Record again
                      </>
                    )}
                  </button>
                  <button className={primary} onClick={generate} disabled={phase.kind === 'generating' || !transcript.trim() || noProject}>
                    {phase.kind === 'generating' ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                    {phase.kind === 'generating' ? 'Asking Claude…' : 'Import'}
                  </button>
                </div>
              </div>
            )}

            {reviewing && drafts.length > 0 && (
              <div className="min-h-0 flex flex-col gap-3">
                <span className="text-xs text-[var(--muted-foreground)]">
                  {drafts.length > 1
                    ? `Claude found ${drafts.length} unrelated requests in this note. Review each proposed topic. Nothing is saved until you click Save.`
                    : 'Review the proposed topic. Nothing is saved until you click Save.'}
                </span>
                {/* The only part that scrolls, both ways, so the heading and Back button stay in view. */}
                <div data-testid="voice-drafts" className="min-h-0 overflow-auto grid grid-flow-col auto-cols-[minmax(min(20rem,100%),1fr)] gap-3">
                  {drafts.map((draft) => (
                    <DraftCard
                      key={draft.id}
                      draft={draft}
                      // An edit makes the last research out of date, but it stays on screen: the user may be working through its list.
                      onChange={(next) => setDrafts(drafts.map((d) => (d.id === next.id ? { ...next, researchStale: true } : d)))}
                      onSave={() => save(draft)}
                      onDiscard={() => removeDraft(draft.id)}
                      onResearch={() => research(draft)}
                      disabled={phase.kind === 'saving'}
                      saving={phase.kind === 'saving' && phase.draftId === draft.id}
                    />
                  ))}
                </div>
                <div className="flex justify-between gap-2">
                  <button
                    className={secondary}
                    title={savedSome ? 'Some topics from this note are already saved' : undefined}
                    onClick={() => setPhase({ kind: 'transcript' })}
                    disabled={phase.kind === 'saving' || researching || savedSome}
                  >
                    {pasted ? 'Back to text' : 'Back to transcript'}
                  </button>
                  {drafts.length > 1 && (
                    <button className={primary} onClick={saveAll} disabled={phase.kind === 'saving' || researching}>
                      {phase.kind === 'saving' && phase.all && <Loader2 className="animate-spin" size={14} />} Save all {drafts.length} topics
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
