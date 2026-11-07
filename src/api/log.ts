// Sends UI errors, failed requests and clicks to the host log (POST /api/log).
// Never throws, and never logs its own failures back to the host.

type Level = 'debug' | 'info' | 'warn' | 'error';
interface Entry {
  level: Level;
  message: string;
  stack?: string;
}

let queue: Entry[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  if (queue.length === 0) return;
  const batch = queue.slice(0, 50);
  queue = queue.slice(50);
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => {});
  if (queue.length > 0) timer = window.setTimeout(flush, 500);
}

export function logClient(level: Level, message: string, stack?: string) {
  if (queue.length > 200) return; // the host is unreachable or we are looping
  queue.push({ level, message, stack });
  if (level === 'error') console.error(message, stack ?? '');
  if (timer === undefined) timer = window.setTimeout(flush, 300);
}

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack };
  try {
    return { message: typeof reason === 'string' ? reason : JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

function clickLabel(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], input[type="checkbox"]');
  if (!el) return null;
  const text = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return `${el.tagName.toLowerCase()} "${text.slice(0, 60) || '(no label)'}"`;
}

export function installClientLogging() {
  window.addEventListener('error', (e) => {
    const { message, stack } = describe(e.error ?? e.message);
    logClient('error', `Uncaught error: ${message} (${e.filename}:${e.lineno}:${e.colno})`, stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const { message, stack } = describe(e.reason);
    logClient('error', `Unhandled rejection: ${message}`, stack);
  });
  document.addEventListener(
    'click',
    (e) => {
      const label = clickLabel(e.target);
      if (label) logClient('info', `click ${label}`);
    },
    true,
  );
  logClient('info', 'UI loaded');
}
