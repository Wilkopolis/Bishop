import { useEffect, useRef, useState } from 'react';
import { Download, FileAudio, Loader2, Mic, Plus, Sparkles, Square, X } from 'lucide-react';
import { api } from '../api/client';
import { startRecording, toWav16k, type Recording } from '../audio/recorder';
import { useBishopStore } from '../store/useBishopStore';
import type { TopicDraft, Transcription, VoiceStatus } from '../types';
import { CategorySelect } from './ProjectOverview';
import { Modal } from './ui';

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing' }
  | { kind: 'transcript' }
  | { kind: 'generating' }
  | { kind: 'review' }
  | { kind: 'saving' };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const btn = 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-50';
const primary = `${btn} bg-[var(--primary)] text-[var(--primary-foreground)]`;
const secondary = `${btn} border border-[var(--border)] hover:bg-[var(--card)]`;
const field = 'w-full px-2 py-1.5 text-sm rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] select-text';

function ModelStatus({ status, onDownload }: { status: VoiceStatus; onDownload: () => void }) {
  const w = status.whisper;
  if (w.state === 'downloading') {
    const pct = w.totalBytes ? (w.downloadedBytes / w.totalBytes) * 100 : 0;
    return (
      <div className="flex flex-col gap-2 text-sm">
        <span>
          Downloading speech model ({w.model})… {mb(w.downloadedBytes)}
          {w.totalBytes ? ` / ${mb(w.totalBytes)}` : ''} MB
        </span>
        <div className="h-1.5 rounded bg-[var(--card)] overflow-hidden">
          <div className="h-full bg-[var(--primary)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
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

export function VoiceTopic({ onClose }: { onClose: () => void }) {
  const { selectedProjectId, saveTopicDraft } = useBishopStore();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [stats, setStats] = useState<Transcription | null>(null);
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [now, setNow] = useState(Date.now());
  const recording = useRef<Recording | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const modelReady = status && (status.whisper.state === 'ready' || status.whisper.state === 'loaded');

  // Poll status until the model is available (covers the download progress).
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await api.voiceStatus();
        if (!alive) return;
        setStatus(s);
        if (s.whisper.state === 'downloading') timer = window.setTimeout(tick, 500);
      } catch (e) {
        if (alive) setError(message(e));
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [status?.whisper.state === 'downloading']);

  // Recording timer.
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [phase.kind]);

  // Never leave the mic open.
  useEffect(() => () => recording.current?.cancel(), []);

  const download = async () => {
    setError(null);
    try {
      setStatus(await api.downloadModel());
    } catch (e) {
      setError(message(e));
    }
  };

  const transcribe = async (wav: Blob) => {
    setPhase({ kind: 'transcribing' });
    try {
      const result = await api.transcribe(wav);
      setStats(result);
      setTranscript(result.text);
      setPhase({ kind: 'transcript' });
      api.voiceStatus().then(setStatus, () => {});
    } catch (e) {
      setError(message(e));
      setPhase({ kind: 'idle' });
    }
  };

  const record = async () => {
    setError(null);
    try {
      recording.current = await startRecording();
      setNow(Date.now());
      setPhase({ kind: 'recording', startedAt: Date.now() });
    } catch (e) {
      setError(message(e));
    }
  };

  const stop = async () => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    try {
      await transcribe(await rec.stop());
    } catch (e) {
      setError(message(e));
      setPhase({ kind: 'idle' });
    }
  };

  const fromFile = async (file: File) => {
    setError(null);
    try {
      await transcribe(await toWav16k(file));
    } catch (e) {
      setError(`Couldn't read that audio file: ${message(e)}`);
      setPhase({ kind: 'idle' });
    }
  };

  const generate = async () => {
    if (selectedProjectId === null) return;
    setError(null);
    setPhase({ kind: 'generating' });
    try {
      setDraft(await api.topicFromTranscript(selectedProjectId, transcript));
      setPhase({ kind: 'review' });
    } catch (e) {
      setError(message(e));
      setPhase({ kind: 'transcript' });
    }
  };

  const save = async () => {
    if (!draft) return;
    const clean: TopicDraft = {
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      tasks: draft.tasks.map((t) => t.trim()).filter(Boolean),
    };
    if (!clean.title) return setError('The topic needs a title.');
    setPhase({ kind: 'saving' });
    if (await saveTopicDraft(clean)) onClose();
    else setPhase({ kind: 'review' });
  };

  const close = () => {
    recording.current?.cancel();
    onClose();
  };

  const busy = phase.kind === 'transcribing' || phase.kind === 'generating' || phase.kind === 'saving';

  return (
    <Modal onClose={busy ? () => {} : close}>
      <div data-testid="voice-topic" className="p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mic size={18} /> New topic from voice
          </h2>
          <button className="p-1 rounded hover:bg-[var(--card)] disabled:opacity-40" title="Close" onClick={close} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        {error && <div className="px-3 py-2 rounded border border-red-800 bg-red-950/60 text-sm text-red-200 select-text">{error}</div>}

        {!status && <Loader2 className="animate-spin" size={18} />}

        {status && !modelReady && <ModelStatus status={status} onDownload={download} />}

        {modelReady && (phase.kind === 'idle' || phase.kind === 'recording' || phase.kind === 'transcribing') && (
          <div className="flex flex-col items-center gap-4 py-6">
            {phase.kind === 'idle' && (
              <>
                <button
                  className="w-20 h-20 rounded-full grid place-items-center bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-110"
                  title="Start recording"
                  onClick={record}
                >
                  <Mic size={32} />
                </button>
                <span className="text-sm text-[var(--muted-foreground)]">Click to record a note about one topic.</span>
                <button className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] flex items-center gap-1" onClick={() => fileInput.current?.click()}>
                  <FileAudio size={13} /> or transcribe an audio file
                </button>
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
              </>
            )}
            {phase.kind === 'recording' && (
              <>
                <button className="w-20 h-20 rounded-full grid place-items-center bg-red-600 text-white animate-pulse" title="Stop recording" onClick={stop}>
                  <Square size={28} fill="currentColor" />
                </button>
                <span className="text-2xl tabular-nums">{clock(now - phase.startedAt)}</span>
                <span className="text-sm text-[var(--muted-foreground)]">Recording… click to stop.</span>
              </>
            )}
            {phase.kind === 'transcribing' && (
              <span className="flex items-center gap-2 text-sm">
                <Loader2 className="animate-spin" size={16} /> Transcribing on {status.whisper.backend ?? 'GPU'}…
              </span>
            )}
          </div>
        )}

        {(phase.kind === 'transcript' || phase.kind === 'generating') && (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Transcript</label>
            <textarea
              aria-label="Transcript"
              className={`${field} min-h-32 resize-y`}
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
              <button className={secondary} onClick={() => setPhase({ kind: 'idle' })} disabled={phase.kind === 'generating'}>
                <Mic size={14} /> Record again
              </button>
              <button className={primary} onClick={generate} disabled={phase.kind === 'generating' || !transcript.trim()}>
                {phase.kind === 'generating' ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                {phase.kind === 'generating' ? 'Asking Claude…' : 'Generate topic'}
              </button>
            </div>
          </div>
        )}

        {(phase.kind === 'review' || phase.kind === 'saving') && draft && (
          <div className="flex flex-col gap-3">
            <span className="text-xs text-[var(--muted-foreground)]">Review the proposed topic. Nothing is saved until you click Save.</span>
            <input
              aria-label="Draft title"
              className={`${field} text-base font-semibold`}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              Category
              <CategorySelect value={draft.category} onChange={(category) => setDraft({ ...draft, category })} className="text-sm" />
            </div>
            <textarea
              aria-label="Draft description"
              className={`${field} min-h-20 resize-y`}
              placeholder="Description"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Tasks</div>
              <ul className="flex flex-col gap-1">
                {draft.tasks.map((t, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <input
                      aria-label={`Draft task ${i + 1}`}
                      className={field}
                      value={t}
                      onChange={(e) => setDraft({ ...draft, tasks: draft.tasks.map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                    <button
                      className="p-1 rounded hover:text-red-400"
                      title="Remove task"
                      onClick={() => setDraft({ ...draft, tasks: draft.tasks.filter((_, j) => j !== i) })}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="mt-1 flex items-center gap-1 text-xs px-2 py-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
                onClick={() => setDraft({ ...draft, tasks: [...draft.tasks, ''] })}
              >
                <Plus size={12} /> Add task
              </button>
            </div>
            <div className="flex justify-between gap-2 border-t border-[var(--border)] pt-3">
              <button className={secondary} onClick={close} disabled={phase.kind === 'saving'}>
                Discard
              </button>
              <div className="flex gap-2">
                <button className={secondary} onClick={() => setPhase({ kind: 'transcript' })} disabled={phase.kind === 'saving'}>
                  Back to transcript
                </button>
                <button className={primary} onClick={save} disabled={phase.kind === 'saving'}>
                  {phase.kind === 'saving' && <Loader2 className="animate-spin" size={14} />} Save topic
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
