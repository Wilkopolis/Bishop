import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logClient } from '../api/log';

interface State {
  error: Error | null;
}

/** Catches render errors, logs them to the host log and shows a reload prompt instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logClient('error', `React render error: ${error.message}`, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium">Something went wrong in Bishop.</p>
        <p className="max-w-md text-sm opacity-70">{this.state.error.message}</p>
        <p className="text-sm opacity-70">The details are in bishop.log.</p>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
