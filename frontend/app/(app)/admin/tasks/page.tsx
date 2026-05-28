'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { confirmDialog } from '@/lib/dialog';
import { TaskBadge } from '@/components/tasks/TaskBadge';
import {
  TASK_LABELS,
  isTerminalTaskStatus,
  type TaskStatus,
} from '@/lib/taskStatus';

type TaskRow = {
  id: string;
  type: 'RECORDING_PIPELINE';
  status: TaskStatus;
  recordingId: string | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResp = { items: TaskRow[]; nextCursor: string | null };

const STATUS_FILTERS: { key: 'all' | 'active' | 'failed' | 'completed'; label: string; statuses?: TaskStatus[] }[] = [
  { key: 'all', label: 'All' },
  {
    key: 'active',
    label: 'Active',
    statuses: [
      'PENDING',
      'CLAIMED',
      'TRANSCODING',
      'EXTRACTING_AUDIO',
      'UPLOADING_AUDIO',
      'THUMBNAIL',
      'HANDED_OFF',
      'TRANSCRIBING',
      'SUMMARIZING',
    ],
  },
  { key: 'failed', label: 'Failed', statuses: ['FAILED'] },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
];

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const t = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (t < 0) return '—';
  if (t < 1000) return `${t} ms`;
  if (t < 60_000) return `${(t / 1000).toFixed(1)} s`;
  return `${Math.floor(t / 60_000)}m ${Math.round((t % 60_000) / 1000)}s`;
}

export default function AdminTasksPage() {
  const [filter, setFilter] = useState<typeof STATUS_FILTERS[number]['key']>('all');
  const [items, setItems] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load() {
    try {
      const f = STATUS_FILTERS.find((x) => x.key === filter);
      const params = new URLSearchParams();
      f?.statuses?.forEach((s) => params.append('status', s));
      const path = `/admin/tasks${params.toString() ? `?${params.toString()}` : ''}`;
      const r = await api<ListResp>(path);
      setItems(r.items);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load tasks');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    // Auto-refresh every 5s — keeps the list lively while tasks run.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function retry(id: string) {
    if (!(await confirmDialog('Re-queue this task?', { title: 'Retry' }))) return;
    try {
      await api(`/admin/tasks/${id}/retry`, { method: 'POST' });
      toast.success('Task re-queued');
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  // Manual retry forces the whisper handoff into PUSH mode — Node uploads
  // the mp3 in the request body instead of letting whisper-server pull it
  // from S3. Use when MinIO is unreachable from the whisper-server host
  // and a normal retry keeps failing on the pull stage.
  async function retryPush(id: string) {
    if (
      !(await confirmDialog(
        'Re-queue this task and force the whisper handoff into PUSH mode (Node uploads the mp3 directly instead of using S3 pull). Use when normal retry fails because whisper-server can\'t reach MinIO.',
        { title: 'Manual retry (push mode)', confirmText: 'Re-queue (push)' },
      ))
    )
      return;
    try {
      await api(`/admin/tasks/${id}/retry`, {
        method: 'POST',
        body: { transport: 'push' },
      });
      toast.success('Task re-queued in push mode');
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'manual retry failed');
    }
  }

  async function cancel(id: string) {
    if (
      !(await confirmDialog('Cancel this task? It cannot be undone.', {
        title: 'Cancel task',
        danger: true,
        confirmText: 'Cancel task',
      }))
    )
      return;
    try {
      await api(`/admin/tasks/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin canceled' }),
      });
      toast.info('Task canceled');
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'cancel failed');
    }
  }

  return (
    <div className="p-6 max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">Worker · Tasks</h1>
        <Button variant="ghost" onClick={load}>
          ↻ Refresh
        </Button>
      </div>

      <div className="flex gap-1 mb-3">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={[
              'px-3 py-1 rounded text-xs font-semibold border',
              filter === f.key
                ? 'bg-accent text-white border-accent'
                : 'bg-paper text-ink border-ink/30 hover:bg-paper-alt',
            ].join(' ')}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="border border-ink rounded overflow-hidden bg-paper">
        <table className="w-full text-sm">
          <thead className="bg-paper-alt border-b border-ink">
            <tr className="text-left text-xs text-ink-soft uppercase">
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Task</th>
              <th className="px-3 py-2 font-semibold">Recording</th>
              <th className="px-3 py-2 font-semibold">Started</th>
              <th className="px-3 py-2 font-semibold">Duration</th>
              <th className="px-3 py-2 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-ink-soft" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-ink-soft" colSpan={6}>
                  No tasks in this view.
                </td>
              </tr>
            )}
            {items.map((t) => (
              <tr key={t.id} className="border-t border-ink/10 hover:bg-paper-alt/40">
                <td className="px-3 py-2">
                  <TaskBadge
                    status={t.status}
                    attempts={t.attempts}
                    errorMessage={t.errorMessage}
                  />
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/admin/tasks/${t.id}`}
                    className="font-mono text-xs hover:underline text-accent"
                  >
                    {t.id.slice(0, 12)}…
                  </Link>
                  <div className="text-[11px] text-ink-mute">{t.type}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {t.recordingId ? `${t.recordingId.slice(0, 12)}…` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-ink-soft">{fmtTime(t.startedAt)}</td>
                <td className="px-3 py-2 text-xs">{fmtDuration(t.startedAt, t.completedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    <Button variant="ghost" onClick={() => retry(t.id)}>
                      Retry
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => retryPush(t.id)}
                      title="Re-queue and force the whisper handoff to push the mp3 in the request body (fallback when S3 pull fails)"
                    >
                      Manual retry
                    </Button>
                    {!isTerminalTaskStatus(t.status) && (
                      <Button variant="danger" onClick={() => cancel(t.id)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[11px] text-ink-mute font-mono">
        Refresh: every 5s · Status legend:{' '}
        {Object.entries(TASK_LABELS).map(([s, l], i) => (
          <span key={s}>
            {i > 0 ? ' · ' : ''}
            <code>{s}</code> = {l}
          </span>
        ))}
      </div>
    </div>
  );
}
