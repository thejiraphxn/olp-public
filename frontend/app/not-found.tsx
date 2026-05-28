import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-alt p-6">
      <div className="w-full max-w-md bg-paper border border-ink rounded p-8 text-center shadow-[3px_3px_0_rgba(0,0,0,0.08)]">
        <div className="font-mono text-xs text-ink-mute">404</div>
        <h1 className="text-2xl font-bold mt-1">Page not found</h1>
        <p className="text-sm text-ink-soft mt-2">
          The course, session or page you were looking for doesn't exist or you don't have access.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link
            href="/dashboard"
            className="h-10 px-4 inline-flex items-center justify-center rounded border border-accent bg-accent text-white font-bold"
          >
            Go to dashboard
          </Link>
          <Link
            href="/login"
            className="h-10 px-4 inline-flex items-center justify-center rounded border border-ink text-ink font-bold"
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
