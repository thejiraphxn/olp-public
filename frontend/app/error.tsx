'use client';
import { useEffect } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ui-error]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-alt p-6">
      <div className="w-full max-w-md bg-paper border border-ink rounded p-8 shadow-[3px_3px_0_rgba(0,0,0,0.08)]">
        <div className="font-mono text-xs text-live">crash</div>
        <h1 className="text-2xl font-bold mt-1">Something went wrong</h1>
        <p className="text-sm text-ink-soft mt-2">
          The page threw an error. You can retry, or go back to the dashboard.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[11px] text-ink-mute">
            error id: {error.digest}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            onClick={reset}
            className="h-10 px-4 rounded border border-accent bg-accent text-white font-bold"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="h-10 px-4 inline-flex items-center justify-center rounded border border-ink text-ink font-bold"
          >
            Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
