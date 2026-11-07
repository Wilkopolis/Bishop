import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AntigravityUsage, ClaudeUsage, UsageWindow } from '../types';

const REFRESH_MS = 2 * 60 * 1000;

// Foreground, not the bar color: it has to show over the solid week fill and over the empty bar, in both themes.
const SESSION_OVERLAY = 'color-mix(in srgb, var(--foreground) 35%, transparent)';

const clampPercent = (reading: UsageWindow) => Math.min(100, Math.max(0, reading.percent));

function describeReading(period: string, reading: UsageWindow) {
  const percent = `${period} ${Math.round(clampPercent(reading))}%`;
  return reading.resets ? `${percent}, resets ${reading.resets}` : percent;
}

function BarText({ model, value }: { model: string; value: string }) {
  return (
    <>
      <span className="truncate">{model}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </>
  );
}

const BAR_TEXT = 'absolute inset-0 flex items-center justify-between gap-2 px-2 text-xs';

/** One bar per model: week as the solid fill, session as a transparent layer over it. Either reading can be missing. */
function UsageRow({
  source,
  model,
  session = null,
  week = null,
  color = 'var(--primary)',
}: {
  source: string;
  model: string;
  session?: UsageWindow | null;
  week?: UsageWindow | null;
  color?: string;
}) {
  const shown = week ?? session;
  const pct = shown === null ? null : clampPercent(shown);
  const fill = week ? clampPercent(week) : 0;
  const value = pct === null ? 'No data' : `${Math.round(pct)}%`;
  const details = [week && describeReading('Week', week), session && describeReading('Session', session)].filter(Boolean);
  return (
    <div
      className="relative h-6 w-full rounded bg-[var(--card)] overflow-hidden"
      role="meter"
      aria-label={`${source} usage: ${model}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(pct)}
      aria-valuetext={details.length > 0 ? details.join('; ') : 'No usage data'}
      title={details.length > 0 ? details.join('\n') : undefined}
    >
      {week && <div className="absolute inset-y-0 left-0 transition-[width]" style={{ width: `${fill}%`, backgroundColor: color }} />}
      {session && <div className="absolute inset-y-0 left-0 transition-[width]" style={{ width: `${clampPercent(session)}%`, backgroundColor: SESSION_OVERLAY }} />}
      {/* Two copies of the text, each clipped to its side of the week fill's edge, so the color changes there, even mid letter. */}
      <div
        className={`${BAR_TEXT} text-[var(--foreground)] transition-[clip-path]`}
        style={{ clipPath: `inset(0 0 0 ${fill}%)` }}
      >
        <BarText model={model} value={value} />
      </div>
      {week && (
        <div
          aria-hidden
          className={`${BAR_TEXT} text-[var(--usage-fill-foreground)] transition-[clip-path]`}
          style={{ clipPath: `inset(0 ${100 - fill}% 0 0)` }}
        >
          <BarText model={model} value={value} />
        </div>
      )}
    </div>
  );
}

/** Usage strip, above the Voice topic strip: readings from each CLI's /usage. Antigravity only shows when agy is installed. */
export function UsageMeter() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [antigravity, setAntigravity] = useState<AntigravityUsage | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      api.claudeUsage().then((u) => { if (live) setUsage(u); }).catch(() => {});
      api.antigravityUsage().then((u) => { if (live) setAntigravity(u); }).catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // Each row is one model group and hides when agy doesn't list it, so a failed read would otherwise leave nothing.
  const hasAntigravityReading = antigravity !== null
    && [antigravity.argon, antigravity.flashSession, antigravity.flashWeek, antigravity.claudeGptSession, antigravity.claudeGptWeek].some(Boolean);

  return (
    <div data-testid="usage-meter" className="shrink-0 flex flex-col gap-2 px-2 py-2 border-t border-[var(--border)]">
      {antigravity?.installed && (
        <>
          <div data-testid="usage-google" role="group" aria-label="Google subscription usage" className="flex flex-col gap-2">
            {antigravity.argon && <UsageRow source="Antigravity" model="Argon 4" week={antigravity.argon} color="var(--antigravity)" />}
            {(antigravity.flashSession || antigravity.flashWeek) && <UsageRow source="Antigravity" model="Flash 3.8" session={antigravity.flashSession} week={antigravity.flashWeek} color="var(--antigravity)" />}
            {(antigravity.claudeGptSession || antigravity.claudeGptWeek) && <UsageRow source="Antigravity" model="Claude and GPT" session={antigravity.claudeGptSession} week={antigravity.claudeGptWeek} color="var(--antigravity)" />}
            {!hasAntigravityReading && <UsageRow source="Antigravity" model="Antigravity" color="var(--antigravity)" />}
          </div>
          <div data-testid="usage-divider" role="separator" className="border-t border-[var(--border)]" />
        </>
      )}
      <div data-testid="usage-claude" role="group" aria-label="Claude usage" className="flex flex-col gap-2">
        <UsageRow source="Claude" model="Claude" session={usage?.session} week={usage?.week} />
      </div>
    </div>
  );
}
