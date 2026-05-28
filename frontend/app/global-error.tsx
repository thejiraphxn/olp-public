'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ fontFamily: 'system-ui', padding: 40, background: '#f4f1ea' }}>
        <h1 style={{ fontSize: 28 }}>Application crashed</h1>
        <p>We hit an unrecoverable error. Please reload the page.</p>
        {error.digest && <p style={{ fontFamily: 'monospace' }}>id: {error.digest}</p>}
        <button onClick={reset} style={{ padding: '8px 16px', marginTop: 12 }}>
          Reload
        </button>
      </body>
    </html>
  );
}
