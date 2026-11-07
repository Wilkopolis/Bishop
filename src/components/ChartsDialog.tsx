import { useEffect, useMemo, useState } from 'react';
import { ChartBar, X } from './icons';
import { api } from '../api/client';
import { useBishopStore } from '../store/useBishopStore';
import type { TaskMetric } from '../types';

interface ModelRow {
  key: string;
  cli: string;
  model: string;
  effort: string;
  tasks: number;
  /** Tasks that have a token count or a duration, for honest averages. */
  tokenTasks: number;
  tokens: number;
  timeTasks: number;
  seconds: number;
}

interface MetricsSummary {
  tasks: number;
  models: number;
  tokenTasks: number;
  tokens: number;
  timeTasks: number;
  seconds: number;
}

function isAntigravity(cli: string): boolean {
  return cli === 'antigravity';
}

function cliLabel(cli: string): string {
  return isAntigravity(cli) ? 'Antigravity (Gemini)' : 'Claude';
}

function cliShortLabel(cli: string): string {
  return isAntigravity(cli) ? 'Gemini' : 'Claude';
}

function cliColor(cli: string): string {
  return isAntigravity(cli) ? 'var(--antigravity)' : 'var(--primary)';
}

function summarizeRows(rows: ModelRow[]): MetricsSummary {
  let tasks = 0;
  let tokenTasks = 0;
  let tokens = 0;
  let timeTasks = 0;
  let seconds = 0;
  for (const r of rows) {
    tasks += r.tasks;
    tokenTasks += r.tokenTasks;
    tokens += r.tokens;
    timeTasks += r.timeTasks;
    seconds += r.seconds;
  }
  return { tasks, models: rows.length, tokenTasks, tokens, timeTasks, seconds };
}

/** Groups metrics by model and reasoning level. NULL means the CLI default was used. */
function groupByModel(metrics: TaskMetric[]): ModelRow[] {
  const map = new Map<string, ModelRow>();
  for (const m of metrics) {
    const model = m.model ?? 'default';
    const effort = m.effort ?? 'default';
    const key = `${m.cli}|${model}|${effort}`;
    let row = map.get(key);
    if (!row) {
      row = { key, cli: m.cli, model, effort, tasks: 0, tokenTasks: 0, tokens: 0, timeTasks: 0, seconds: 0 };
      map.set(key, row);
    }
    row.tasks += 1;
    if (m.inputTokens !== null || m.outputTokens !== null) {
      row.tokenTasks += 1;
      row.tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
    }
    if (m.durationSeconds !== null) {
      row.timeTasks += 1;
      row.seconds += m.durationSeconds;
    }
  }
  return [...map.values()].sort((a, b) => b.tasks - a.tasks);
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type ChartSort = 'asc' | 'desc' | 'tasks' | 'name';
type CliFilter = 'all' | 'claude' | 'antigravity';

interface BarDatum {
  key: string;
  cli: string;
  model: string;
  effort: string;
  label: string;
  avg: number;
  tasks: number;
}

function sortBars(items: BarDatum[], sort: ChartSort): BarDatum[] {
  return [...items].sort((a, b) => {
    if (sort === 'desc') return b.avg - a.avg || a.label.localeCompare(b.label);
    if (sort === 'tasks') return b.tasks - a.tasks || a.avg - b.avg;
    if (sort === 'name') return a.label.localeCompare(b.label);
    return a.avg - b.avg || a.label.localeCompare(b.label);
  });
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Dots get more solid as reasoning effort goes up. Unknown levels (and "default") are fully solid. */
function effortOpacity(effort: string, efforts: string[]): number {
  const ranked = efforts.filter((e) => EFFORT_ORDER.includes(e)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  const i = ranked.indexOf(effort);
  if (i < 0 || ranked.length < 2) return 1;
  return 0.4 + (0.6 * i) / (ranked.length - 1);
}

function sortEfforts(efforts: string[]): string[] {
  const rank = (e: string) => (EFFORT_ORDER.includes(e) ? EFFORT_ORDER.indexOf(e) : EFFORT_ORDER.length);
  return [...efforts].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Legend for the models (service color) and reasoning efforts (dot opacity) that appear in the chart. */
function ChartLegend({ data }: { data: BarDatum[] }) {
  const efforts = sortEfforts([...new Set(data.map((d) => d.effort))]);
  const models = new Map<string, string>();
  for (const d of data) models.set(`${d.cli}|${d.model}`, d.cli);
  const modelItems = [...models.entries()]
    .map(([k, cli]) => ({ key: k, cli, model: k.slice(cli.length + 1) }))
    .sort((a, b) => a.cli.localeCompare(b.cli) || a.model.localeCompare(b.model));
  return (
    <div className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]" data-testid="chart-legend">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="chart-legend-models">
        <span className="font-medium text-[var(--foreground)]">Model</span>
        {modelItems.map((m) => (
          <span key={m.key} className="inline-flex items-center gap-1.5" title={cliLabel(m.cli)}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: cliColor(m.cli) }} />
            {m.model}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="chart-legend-efforts">
        <span className="font-medium text-[var(--foreground)]">Reasoning</span>
        {efforts.map((e) => (
          <span key={e} className="inline-flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: 'var(--muted-foreground)', opacity: effortOpacity(e, efforts) }}
            />
            {e}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChartSortControl({
  sort,
  onChange,
  ascLabel,
  descLabel,
}: {
  sort: ChartSort;
  onChange: (sort: ChartSort) => void;
  ascLabel: string;
  descLabel: string;
}) {
  const options: { id: ChartSort; label: string }[] = [
    { id: 'asc', label: ascLabel },
    { id: 'desc', label: descLabel },
    { id: 'tasks', label: 'Most tasks' },
    { id: 'name', label: 'Model A-Z' },
  ];
  return (
    <div
      role="group"
      aria-label="Sort chart"
      data-testid="chart-sort"
      className="inline-flex items-center p-0.5 rounded-md border border-[var(--border)] bg-[var(--background)] text-xs"
    >
      {options.map((o) => {
        const active = sort === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            data-testid={`chart-sort-${o.id}`}
            className={`px-2 py-0.5 rounded transition-colors ${
              active
                ? 'bg-[var(--card)] text-[var(--foreground)] font-medium shadow-sm'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Rounds a maximum up to a tidy axis end and returns evenly spaced ticks from 0. */
function niceAxis(max: number, steps = 4): { end: number; ticks: number[] } {
  const raw = max / steps;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const count = Math.max(Math.ceil(max / step), 1);
  return { end: step * count, ticks: Array.from({ length: count + 1 }, (_, i) => step * i) };
}

/** Dot plot: one row per model and reasoning level, a dot at its average on a shared value axis. */
function DotChart({
  data,
  format,
  testId,
}: {
  data: BarDatum[];
  format: (n: number) => string;
  testId: string;
}) {
  const { end, ticks } = niceAxis(Math.max(...data.map((d) => d.avg), 1));
  const efforts = [...new Set(data.map((d) => d.effort))];
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5">
      {data.map((d) => (
        <div
          key={d.key}
          className="flex items-center gap-2 h-5 text-xs"
          title={`${cliLabel(d.cli)} · ${d.tasks} task${d.tasks === 1 ? '' : 's'}`}
        >
          <div className="w-36 shrink-0 truncate text-right text-[var(--muted-foreground)]">{d.label}</div>
          <div className="relative flex-1 h-full">
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute top-0 bottom-0 border-l border-[var(--border)]"
                style={{ left: `${(t / end) * 100}%` }}
              />
            ))}
            <div
              className="absolute top-1/2 h-px"
              style={{ left: 0, width: `${(d.avg / end) * 100}%`, backgroundColor: cliColor(d.cli), opacity: 0.45 }}
            />
            <div
              className="absolute top-1/2 w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${(d.avg / end) * 100}%`, backgroundColor: cliColor(d.cli), opacity: effortOpacity(d.effort, efforts) }}
            />
          </div>
          <div className="w-14 shrink-0 tabular-nums text-[var(--foreground)]">{format(d.avg)}</div>
        </div>
      ))}
      <div className="flex items-center gap-2 text-[10px] text-[var(--muted-foreground)]">
        <div className="w-36 shrink-0" />
        <div className="relative flex-1 h-4">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute tabular-nums -translate-x-1/2"
              style={{ left: `${(t / end) * 100}%` }}
            >
              {format(t)}
            </span>
          ))}
        </div>
        <div className="w-14 shrink-0" />
      </div>
    </div>
  );
}

/** Average tokens per task for each model and reasoning level. */
function ValueChart({ rows, sort, onSortChange }: { rows: ModelRow[]; sort: ChartSort; onSortChange: (sort: ChartSort) => void }) {
  const data = sortBars(
    rows
      .filter((r) => r.tokenTasks > 0)
      .map((r) => ({ key: r.key, cli: r.cli, model: r.model, effort: r.effort, label: `${r.model} / ${r.effort}`, avg: r.tokens / r.tokenTasks, tasks: r.tokenTasks })),
    sort,
  );
  if (data.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]" data-testid="value-chart-empty">
        No token counts yet, so there is nothing to chart.
      </p>
    );
  }
  return (
    <div data-testid="value-chart">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-[var(--foreground)]">Average tokens per task</span>
            <span className="text-xs text-[var(--muted-foreground)]">Input + output</span>
          </div>
          <ChartLegend data={data} />
        </div>
        <ChartSortControl sort={sort} onChange={onSortChange} ascLabel="Lowest first" descLabel="Highest first" />
      </div>
      <DotChart data={data} format={formatCount} testId="value-chart-plot" />
    </div>
  );
}

/** Average time per task for each model and reasoning level. */
function TimeChart({ rows, sort, onSortChange }: { rows: ModelRow[]; sort: ChartSort; onSortChange: (sort: ChartSort) => void }) {
  const data = sortBars(
    rows
      .filter((r) => r.timeTasks > 0)
      .map((r) => ({ key: r.key, cli: r.cli, model: r.model, effort: r.effort, label: `${r.model} / ${r.effort}`, avg: r.seconds / r.timeTasks, tasks: r.timeTasks })),
    sort,
  );
  if (data.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]" data-testid="time-chart-empty">
        No task times yet, so there is nothing to chart.
      </p>
    );
  }
  return (
    <div data-testid="time-chart">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs font-medium text-[var(--foreground)]">Average time per task</div>
          <ChartLegend data={data} />
        </div>
        <ChartSortControl sort={sort} onChange={onSortChange} ascLabel="Fastest first" descLabel="Slowest first" />
      </div>
      <DotChart data={data} format={formatDuration} testId="time-chart-plot" />
    </div>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 flex flex-col gap-0.5">
      <span className="text-xs text-[var(--muted-foreground)]">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{value}</span>
      {detail && <span className="text-xs text-[var(--muted-foreground)] tabular-nums">{detail}</span>}
    </div>
  );
}

function CliSummaryCard({
  cli,
  summary,
  testId,
}: {
  cli: 'claude' | 'antigravity';
  summary: MetricsSummary;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: cliColor(cli) }} />
          <span className="text-xs font-medium text-[var(--foreground)]">{cliLabel(cli)}</span>
        </div>
        <span className="text-xs tabular-nums text-[var(--muted-foreground)]">
          {summary.tasks} task{summary.tasks === 1 ? '' : 's'} · {summary.models} model{summary.models === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--muted-foreground)]">Avg tokens</span>
          <span className="font-medium tabular-nums text-[var(--foreground)]">
            {summary.tokenTasks ? formatCount(summary.tokens / summary.tokenTasks) : '-'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--muted-foreground)]">Total tokens</span>
          <span className="font-medium tabular-nums text-[var(--foreground)]">
            {summary.tokenTasks ? formatCount(summary.tokens) : '-'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--muted-foreground)]">Avg time</span>
          <span className="font-medium tabular-nums text-[var(--foreground)]">
            {summary.timeTasks ? formatDuration(summary.seconds / summary.timeTasks) : '-'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--muted-foreground)]">Total time</span>
          <span className="font-medium tabular-nums text-[var(--foreground)]">
            {summary.timeTasks ? formatDuration(summary.seconds) : '-'}
          </span>
        </div>
      </div>
    </div>
  );
}

function CliFilterControl({ filter, onChange }: { filter: CliFilter; onChange: (f: CliFilter) => void }) {
  const options: { id: CliFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'claude', label: 'Claude' },
    { id: 'antigravity', label: 'Antigravity (Gemini)' },
  ];
  return (
    <div
      role="group"
      aria-label="Filter by service"
      data-testid="charts-cli-filter"
      className="inline-flex items-center p-0.5 rounded-md border border-[var(--border)] bg-[var(--background)] text-xs"
    >
      {options.map((o) => {
        const active = filter === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            data-testid={`charts-cli-filter-${o.id}`}
            className={`px-2 py-0.5 rounded transition-colors ${
              active
                ? 'bg-[var(--card)] text-[var(--foreground)] font-medium shadow-sm'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The charts the dialog can show, one tab each. */
const CHART_TABS = [
  { id: 'value', label: 'Value per model' },
  { id: 'time', label: 'Time per model' },
] as const;

type ChartTab = (typeof CHART_TABS)[number]['id'];

/** Performance charts pop-up, opened from the Charts button in the title bar. Close with the X, Esc or a click outside. */
export function ChartsDialog() {
  const { chartsOpen, setChartsOpen } = useBishopStore();
  const [tab, setTab] = useState<ChartTab>('value');
  const [sort, setSort] = useState<ChartSort>('asc');
  const [cliFilter, setCliFilter] = useState<CliFilter>('all');
  const [metrics, setMetrics] = useState<TaskMetric[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chartsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chartsOpen, setChartsOpen]);

  // Load fresh numbers each time the dialog opens.
  useEffect(() => {
    if (!chartsOpen) return;
    let cancelled = false;
    setMetrics(null);
    setError(null);
    api
      .taskMetrics()
      .then((m) => !cancelled && setMetrics(m))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load metrics'));
    return () => {
      cancelled = true;
    };
  }, [chartsOpen]);

  // Date range filter. Values are local dates (yyyy-mm-dd) from the date inputs; empty means open-ended.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filtered = useMemo(() => {
    if (!metrics) return null;
    if (!from && !to) return metrics;
    const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    // End of the "to" day, local time.
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    return metrics.filter((m) => {
      const t = new Date(m.completedAt).getTime();
      return t >= start && t <= end;
    });
  }, [metrics, from, to]);

  const allRows = useMemo(() => groupByModel(filtered ?? []), [filtered]);
  const claudeSummary = useMemo(() => summarizeRows(allRows.filter((r) => !isAntigravity(r.cli))), [allRows]);
  const antigravitySummary = useMemo(() => summarizeRows(allRows.filter((r) => isAntigravity(r.cli))), [allRows]);
  const rows = useMemo(
    () =>
      cliFilter === 'all'
        ? allRows
        : allRows.filter((r) => (cliFilter === 'antigravity' ? isAntigravity(r.cli) : !isAntigravity(r.cli))),
    [allRows, cliFilter],
  );
  const totals = useMemo(() => summarizeRows(rows), [rows]);

  if (!chartsOpen) return null;

  const close = () => setChartsOpen(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-center p-6" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Performance charts"
        data-testid="charts-dialog"
        className="w-full max-w-5xl h-[82vh] flex flex-col rounded-lg border border-[var(--border)] bg-[var(--sidebar)] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 h-11 shrink-0 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ChartBar size={16} className="text-[var(--muted-foreground)]" /> Performance charts
          </div>
          <button
            aria-label="Close"
            title="Close"
            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div role="tablist" aria-orientation="vertical" aria-label="Charts" className="w-44 shrink-0 p-2.5 flex flex-col gap-1 border-r border-[var(--border)]">
            {CHART_TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  data-testid={`charts-tab-${t.id}`}
                  className={`text-left text-sm px-3 py-2 rounded ${
                    active
                      ? 'bg-[var(--primary-subtle)] text-[var(--primary-text)] font-medium'
                      : 'text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]'
                  }`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" aria-label={CHART_TABS.find((t) => t.id === tab)?.label} className="flex-1 min-w-0 overflow-auto p-5 bg-[var(--center-bg)]">
            {error ? (
              <p className="text-sm text-[var(--primary-text)]">{error}</p>
            ) : !metrics ? (
              <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
            ) : allRows.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)]" data-testid="charts-empty">
                {metrics.length > 0 ? 'No tasks finished in this date range.' : 'No data yet. Metrics are saved when Claude or Antigravity finishes a task.'}
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="charts-summary">
                  <SummaryCard
                    label="Tasks completed"
                    value={String(totals.tasks)}
                    detail={
                      cliFilter === 'all'
                        ? `${claudeSummary.tasks} Claude · ${antigravitySummary.tasks} Gemini`
                        : `${rows.length} model${rows.length === 1 ? '' : 's'}`
                    }
                  />
                  <SummaryCard
                    label="Avg tokens / task"
                    value={totals.tokenTasks ? formatCount(totals.tokens / totals.tokenTasks) : '-'}
                    detail={totals.tokenTasks ? `${formatCount(totals.tokens)} total` : 'No token data'}
                  />
                  <SummaryCard
                    label="Avg time / task"
                    value={totals.timeTasks ? formatDuration(totals.seconds / totals.timeTasks) : '-'}
                    detail={totals.timeTasks ? `${formatDuration(totals.seconds)} total` : 'No time data'}
                  />
                  <SummaryCard
                    label={tab === 'value' ? 'Total tokens' : 'Total time'}
                    value={
                      tab === 'value'
                        ? totals.tokenTasks
                          ? formatCount(totals.tokens)
                          : '-'
                        : totals.timeTasks
                          ? formatDuration(totals.seconds)
                          : '-'
                    }
                    detail={tab === 'value' ? `${totals.tokenTasks} counted` : `${totals.timeTasks} timed`}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="charts-cli-summary">
                  <CliSummaryCard cli="claude" summary={claudeSummary} testId="charts-cli-claude" />
                  <CliSummaryCard cli="antigravity" summary={antigravitySummary} testId="charts-cli-antigravity" />
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
                  {tab === 'value' ? (
                    <ValueChart rows={rows} sort={sort} onSortChange={setSort} />
                  ) : (
                    <TimeChart rows={rows} sort={sort} onSortChange={setSort} />
                  )}
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--border)]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--foreground)]">Model breakdown</span>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {rows.length} configuration{rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <CliFilterControl filter={cliFilter} onChange={setCliFilter} />
                  </div>
                  <table className="w-full text-sm" data-testid="charts-data">
                    <thead>
                      <tr className="text-left text-xs text-[var(--muted-foreground)] border-b border-[var(--border)] bg-[var(--sidebar)]/40">
                        <th className="py-2 pl-4 pr-3 font-medium">Model</th>
                        <th className="py-2 pr-3 font-medium">Reasoning</th>
                        <th className="py-2 pr-3 font-medium text-right">Tasks</th>
                        <th className={`py-2 pr-3 font-medium text-right ${tab === 'value' ? 'text-[var(--foreground)]' : ''}`}>Avg tokens</th>
                        <th className={`py-2 pr-3 font-medium text-right ${tab === 'value' ? 'text-[var(--foreground)]' : ''}`}>Total tokens</th>
                        <th className={`py-2 pr-3 font-medium text-right ${tab === 'time' ? 'text-[var(--foreground)]' : ''}`}>Avg time</th>
                        <th className={`py-2 pr-4 font-medium text-right ${tab === 'time' ? 'text-[var(--foreground)]' : ''}`}>Total time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--sidebar)]/40">
                          <td className="py-2 pl-4 pr-3 font-medium">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: cliColor(r.cli) }}
                                title={cliLabel(r.cli)}
                              />
                              <span>{r.model}</span>
                              <span className="text-xs font-normal text-[var(--muted-foreground)]">{cliShortLabel(r.cli)}</span>
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-[var(--muted-foreground)]">{r.effort}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.tasks}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.tokenTasks ? formatCount(r.tokens / r.tokenTasks) : '-'}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-[var(--muted-foreground)]">{r.tokenTasks ? formatCount(r.tokens) : '-'}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.timeTasks ? formatDuration(r.seconds / r.timeTasks) : '-'}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-[var(--muted-foreground)]">{r.timeTasks ? formatDuration(r.seconds) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 shrink-0 border-t border-[var(--border)] text-sm" data-testid="charts-date-filter">
          <span className="text-[var(--muted-foreground)]">Date range</span>
          <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              data-testid="charts-date-from"
              className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              data-testid="charts-date-to"
              className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {(from || to) && (
            <button
              className="px-2 py-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]"
              data-testid="charts-date-clear"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Clear
            </button>
          )}
          {metrics && filtered && (
            <span className="ml-auto text-xs text-[var(--muted-foreground)]">
              {filtered.length} of {metrics.length} task{metrics.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
