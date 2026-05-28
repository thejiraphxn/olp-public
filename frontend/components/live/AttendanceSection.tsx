'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { CourseRole } from '@/lib/enums';

type Stint = { joinedAt: string; leftAt: string | null; seconds: number };
type Row = {
  userId: string;
  userName: string;
  email: string;
  role: CourseRole;
  // Guest viewers (anonymous on PUBLIC courses) — userId is synthetic
  // ('guest:<name>'), email is empty. Renders with a different badge so
  // the teacher can tell them apart from enrolled students.
  isGuest: boolean;
  totalSeconds: number;
  stintCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  stints: Stint[];
};

function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AttendanceSection({
  courseId,
  sessionId,
}: {
  courseId: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ attendance: Row[] }>(
        `/courses/${courseId}/sessions/${sessionId}/attendance`,
      );
      setRows(res.attendance);
    } catch (e: any) {
      setError(e?.body?.error ?? e?.message ?? 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !rows && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const students = (rows ?? []).filter((r) => r.role === CourseRole.STUDENT);
  const attended = students.filter((r) => r.totalSeconds > 0);
  const noShow = students.filter((r) => r.totalSeconds === 0 && !r.isGuest);

  return (
    <div className="border border-ink rounded">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-3 hover:bg-paper-alt text-left"
      >
        <div>
          <div className="font-bold text-sm">📋 Attendance</div>
          <div className="text-xs text-ink-soft">
            Who joined the live session and how long they stayed
          </div>
        </div>
        <div className="flex items-center gap-2">
          {rows && (
            <span className="text-[10px] text-ink-soft font-mono">
              {attended.length}/{students.length} attended
            </span>
          )}
          <span className="text-base text-ink-soft leading-none">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-ink p-3">
          {loading && <div className="text-xs text-ink-soft">Loading…</div>}
          {error && <div className="text-xs text-live">{error}</div>}
          {rows && !loading && (
            <>
              <div className="flex justify-end mb-2">
                <Button variant="ghost" size="sm" onClick={load}>
                  ↻ Refresh
                </Button>
              </div>
              {attended.length === 0 && noShow.length === 0 && (
                <div className="text-xs text-ink-soft">No enrolled students.</div>
              )}
              {attended.length > 0 && (
                <div className="flex flex-col gap-1">
                  {attended.map((r) => {
                    const expanded = expandedUserId === r.userId;
                    return (
                      <div key={r.userId} className="border border-ink-soft rounded">
                        <button
                          onClick={() =>
                            setExpandedUserId(expanded ? null : r.userId)
                          }
                          className="w-full flex items-center gap-3 p-2 hover:bg-paper-alt text-left"
                        >
                          <Avatar name={r.userName} size={28} />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate flex items-center gap-1.5">
                              {r.userName}
                              {r.isGuest && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/40 font-bold">
                                  GUEST
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-ink-soft truncate">
                              {r.email || (r.isGuest ? 'anonymous viewer' : '')}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-sm font-bold">
                              {formatDuration(r.totalSeconds)}
                            </div>
                            <div className="text-[10px] text-ink-soft">
                              {r.stintCount} {r.stintCount === 1 ? 'stint' : 'stints'}
                              {r.firstSeenAt && ` · ${formatTime(r.firstSeenAt)}`}
                            </div>
                          </div>
                          <span className="text-base text-ink-soft w-4 leading-none">{expanded ? '▾' : '▸'}</span>
                        </button>
                        {expanded && (
                          <div className="px-3 pb-2 pt-1 border-t border-ink-soft text-xs text-ink-soft">
                            {r.stints.map((s, i) => (
                              <div key={i} className="flex justify-between font-mono">
                                <span>
                                  {formatTime(s.joinedAt)} →{' '}
                                  {s.leftAt ? formatTime(s.leftAt) : <span className="text-live">live now</span>}
                                </span>
                                <span>{formatDuration(s.seconds)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {noShow.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold text-ink-soft uppercase mb-1">
                    No-show ({noShow.length})
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {noShow.map((r) => (
                      <div
                        key={r.userId}
                        className="flex items-center gap-2 px-1 py-0.5 text-xs text-ink-mute"
                      >
                        <Avatar name={r.userName} size={20} />
                        <span className="flex-1 truncate">{r.userName}</span>
                        <span className="text-[10px]">—</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
