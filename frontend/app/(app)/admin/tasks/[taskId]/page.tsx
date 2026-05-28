'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { confirmDialog } from '@/lib/dialog';
import { TaskBadge } from '@/components/tasks/TaskBadge';
import {
  isTerminalTaskStatus,
  type TaskStatus,
} from '@/lib/taskStatus';

type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  message: string;
};

type TaskDetail = {
  id: string;
  type: 'RECORDING_PIPELINE';
  status: TaskStatus;
  recordingId: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  logs: LogEntry[];
  lockedBy: string | null;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'text-ink-soft',
  warn: 'text-warn',
  error: 'text-live',
};

export default function AdminTaskDetailPage({ params }: { params: { taskId: string } }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load() {
    try {
      const t = await api<TaskDetail>(`/admin/tasks/${params.taskId}`);
      setTask(t);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load task');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    // Poll while task is non-terminal so the operator sees stages live.
    const t = setInterval(() => {
      if (task && isTerminalTaskStatus(task.status)) return;
      load();
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.taskId, task?.status]);

  async function retry() {
    if (!(await confirmDialog('Re-queue this task?', { title: 'Retry' }))) return;
    try {
      await api(`/admin/tasks/${params.taskId}/retry`, { method: 'POST' });
      toast.success('Task re-queued');
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  // Manual retry forces whisper handoff into PUSH mode (Node uploads mp3
  // in the request body). Use when MinIO is unreachable from whisper-server.
  async function retryPush() {
    if (
      !(await confirmDialog(
        'Re-queue this task and force the whisper handoff into PUSH mode (Node uploads the mp3 directly instead of using S3 pull).',
        { title: 'Manual retry (push mode)', confirmText: 'Re-queue (push)' },
      ))
    )
      return;
    try {
      await api(`/admin/tasks/${params.taskId}/retry`, {
        method: 'POST',
        body: { transport: 'push' },
      });
      toast.success('Task re-queued in push mode');
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'manual retry failed');
    }
  }

  async function cancel() {
    if (
      !(await confirmDialog('Cancel this task?', {
        title: 'Cancel task',
        danger: true,
        confirmText: 'Cancel task',
      }))
    )
      return;
    try {
      await api(`/admin/tasks/${params.taskId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin canceled' }),
      });
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'cancel failed');
    }
  }

  if (loading && !task) return <div className="p-6 text-ink-soft">Loading…</div>;
  if (!task) return <div className="p-6 text-ink-soft">Not found.</div>;

  return (
    <div className="p-6 max-w-[900px] flex flex-col gap-4">
      <div>
        <Link
          href="/admin/tasks"
          className="text-[11px] font-mono text-ink-mute hover:underline"
        >
          ← back to tasks
        </Link>
        <div className="flex items-center gap-3 mt-1">
          <h1 className="text-lg font-bold">Task</h1>
          <TaskBadge
            status={task.status}
            attempts={task.attempts}
            errorMessage={task.errorMessage}
          />
        </div>
        <div className="font-mono text-xs text-ink-mute mt-1">{task.id}</div>
      </div>

      <div className="border border-ink rounded p-4 bg-paper grid grid-cols-2 gap-y-2 gap-x-6 text-sm">
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Type</div>
          <div className="font-mono text-xs">{task.type}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Recording</div>
          <div className="font-mono text-xs">{task.recordingId ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Attempts</div>
          <div>
            {task.attempts} / {task.maxAttempts}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Lock holder</div>
          <div className="font-mono text-xs">{task.lockedBy ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Started</div>
          <div className="text-xs">{task.startedAt ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-mute uppercase">Completed</div>
          <div className="text-xs">{task.completedAt ?? '—'}</div>
        </div>
        {task.errorMessage && (
          <div className="col-span-2">
            <div className="text-[11px] text-live uppercase font-bold">Error</div>
            <pre className="text-xs text-live whitespace-pre-wrap bg-live-soft border border-live rounded p-2 mt-1">
              {task.errorMessage}
            </pre>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={load}>
          ↻ Refresh
        </Button>
        <Button variant="primary" onClick={retry}>
          Retry
        </Button>
        <Button
          variant="ghost"
          onClick={retryPush}
          title="Re-queue and force the whisper handoff to push the mp3 in the request body (fallback when S3 pull fails)"
        >
          Manual retry
        </Button>
        {!isTerminalTaskStatus(task.status) && (
          <Button variant="danger" onClick={cancel}>
            Cancel task
          </Button>
        )}
      </div>

      <div>
        <h2 className="font-bold mb-2 text-sm">
          Logs <span className="text-ink-mute font-normal">({task.logs.length})</span>
        </h2>
        <div className="border border-ink rounded bg-paper-alt overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-ink/10 text-ink-mute">
                <th className="text-left px-3 py-1.5 font-semibold">Time</th>
                <th className="text-left px-3 py-1.5 font-semibold">Level</th>
                <th className="text-left px-3 py-1.5 font-semibold">Stage</th>
                <th className="text-left px-3 py-1.5 font-semibold">Message</th>
              </tr>
            </thead>
            <tbody>
              {task.logs.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-ink-mute" colSpan={4}>
                    No log entries yet.
                  </td>
                </tr>
              )}
              {task.logs.map((entry, i) => (
                <tr key={i} className="border-t border-ink/5 align-top">
                  <td className="px-3 py-1 text-ink-mute whitespace-nowrap">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </td>
                  <td className={`px-3 py-1 ${LEVEL_COLOR[entry.level]}`}>{entry.level}</td>
                  <td className="px-3 py-1">{entry.stage}</td>
                  <td className="px-3 py-1 whitespace-pre-wrap break-words">{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
