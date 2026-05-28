'use client';
/**
 * Direct viewer for the Python whisper-server's app.log.
 *
 * The browser hits Python at NEXT_PUBLIC_WHISPER_URL (default
 * http://127.0.0.1:8000) — it does NOT proxy through the Node API.
 * Auth uses the same shared-secret as the rest of the whisper-server
 * (NEXT_PUBLIC_WHISPER_API_KEY). When that value is blank, the
 * endpoint is open — fine for dev, set the key in prod.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

const WHISPER_URL = process.env.NEXT_PUBLIC_WHISPER_URL ?? 'http://127.0.0.1:8000';
const WHISPER_KEY = process.env.NEXT_PUBLIC_WHISPER_API_KEY ?? '';

type LogResp = {
  path: string;
  lines: string[];
  count: number;
};

const LINE_LIMITS = [100, 200, 500, 1000, 2000];

function levelClass(line: string): string {
  if (/\[ERROR\]|ERROR\b/.test(line)) return 'text-live';
  if (/\[WARNING\]|WARN\b/.test(line)) return 'text-warn';
  if (/\[DEBUG\]/.test(line)) return 'text-ink-mute';
  return 'text-ink-soft';
}

export default function AdminLogsPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [path, setPath] = useState<string>('');
  const [limit, setLimit] = useState<number>(500);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stickyBottom, setStickyBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${WHISPER_URL}/v1/logs?lines=${limit}`, {
        headers: WHISPER_KEY ? { Authorization: `Bearer ${WHISPER_KEY}` } : {},
        // No credentials — Python's CORS allow_credentials=true is fine
        // either way; the API key (if any) goes in the header.
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`whisper-server ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as LogResp;
      setLines(data.lines);
      setPath(data.path);
      setError(null);
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? 'failed to fetch logs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    // Light poll every 3s — log volume is small and refreshing keeps the
    // operator in sync with what Python is doing.
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, autoRefresh]);

  // Auto-scroll to bottom when new lines arrive AND we were at bottom.
  useEffect(() => {
    if (!stickyBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, stickyBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    setStickyBottom(atBottom);
  }

  const filtered = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  function copyAll() {
    navigator.clipboard
      .writeText(filtered.join('\n'))
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Copy failed'));
  }

  return (
    <div className="p-6 max-w-[1400px] flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Whisper logs</h1>
        <div className="text-[11px] font-mono text-ink-mute">
          source: {WHISPER_URL} {path && <>· file: <code>{path}</code></>}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-ink-soft">Tail</label>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="border border-ink rounded px-2 py-1 text-xs bg-paper"
        >
          {LINE_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n} lines
            </option>
          ))}
        </select>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter (substring)"
          className="border border-ink rounded px-2 py-1 text-xs bg-paper flex-1 min-w-[160px]"
        />

        <label className="text-xs flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (3s)
        </label>

        <Button variant="ghost" onClick={load}>
          ↻ Refresh
        </Button>
        <Button variant="ghost" onClick={copyAll}>
          📋 Copy
        </Button>
      </div>

      {error && (
        <div className="border border-live bg-live-soft text-live rounded p-2 text-xs">
          {error}
          <div className="text-[11px] text-ink-soft mt-1">
            Make sure the whisper-server is running and reachable at{' '}
            <code>{WHISPER_URL}</code>. CORS must include this origin (CORS_ORIGIN
            env, default <code>*</code>).
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="border border-ink rounded bg-[#1a1a1a] text-[#d6d6d6] font-mono text-[11px] leading-[1.4] overflow-y-auto p-2"
        style={{ height: '70vh' }}
      >
        {filtered.length === 0 && !loading && (
          <div className="text-ink-mute text-center py-6">No log lines.</div>
        )}
        {filtered.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${levelClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>

      <div className="text-[11px] text-ink-mute font-mono">
        showing {filtered.length} / {lines.length} lines
        {filter && ` (filtered by "${filter}")`}
        {!stickyBottom && (
          <button
            className="ml-2 underline"
            onClick={() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                setStickyBottom(true);
              }
            }}
          >
            ↓ jump to bottom
          </button>
        )}
      </div>
    </div>
  );
}
