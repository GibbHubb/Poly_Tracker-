import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * PT35 — a render error used to unmount the whole tree and leave a white page.
 * Now it leaves a message and a way back. Queued offline edits live in
 * IndexedDB, so a reload loses nothing that was saved.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className="flex h-full flex-col items-center justify-center gap-4 bg-slate-900 p-6 text-center text-slate-100"
      >
        <h1 className="text-lg font-semibold">Something went wrong on this screen.</h1>
        <p className="max-w-md text-sm text-slate-300">
          Your offline edits are kept on this device. Reload to try again, or go back to the
          farm list.
        </p>
        <p className="max-w-md break-words font-mono text-xs text-slate-500">{error.message}</p>
        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="min-h-[44px] rounded-md bg-brand px-4 py-2 text-sm font-medium text-white"
          >
            Reload
          </button>
          <a
            href="/"
            className="flex min-h-[44px] items-center rounded-md bg-slate-700 px-4 py-2 text-sm text-slate-100"
          >
            Farm list
          </a>
        </div>
      </div>
    );
  }
}
