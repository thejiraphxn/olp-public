'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, qs, type Paginated } from '@/lib/api';
import { confirmDialog, promptDialog } from '@/lib/dialog';
import { Button } from '@/components/ui/Button';
import { StatusPill, sessionStatusPillKind } from '@/components/ui/StatusPill';
import { fmtDuration } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  CourseRole,
  CourseVisibility,
  RecordingStatus,
  SessionStatus,
  pickCourseCover,
} from '@/lib/enums';

type Course = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  coverColor: string | null;
  visibility: CourseVisibility;
  joinCode: string | null;
  sessionCount: number;
  memberCount: number;
  myRole: CourseRole | null;
  owner: { id: string; name: string; email: string };
};

type Session = {
  id: string;
  courseId: string;
  title: string;
  status: string;
  scheduledAt: string | null;
  // accessCode is included for teachers (raw value); for everyone else this
  // field is undefined and they only get `requiresAccessCode` to render UI.
  accessCode?: string | null;
  requiresAccessCode?: boolean;
  recording: null | { id: string; status: string; durationSec: number | null };
};

type View = 'table' | 'timeline' | 'kanban';

export default function CourseDetailPage({ params }: { params: { courseId: string } }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tab, setTab] = useState<'sessions' | 'members'>('sessions');
  const [view, setView] = useState<View>('table');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const toast = useToast();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      const [c, s] = await Promise.all([
        api<Course>(`/courses/${params.courseId}`),
        api<Paginated<Session>>(
          `/courses/${params.courseId}/sessions${qs({ q, status: statusFilter, limit: 100 })}`,
        ),
      ]);
      setCourse(c);
      setSessions(s.items);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load course');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(reload, q ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.courseId, q, statusFilter]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.key === 'n' || e.key === 'N') && course?.myRole === CourseRole.TEACHER) {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === '1') setView('table');
      else if (e.key === '2') setView('timeline');
      else if (e.key === '3') setView('kanban');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [course?.myRole]);

  async function renameCourse() {
    if (!course) return;
    const title = await promptDialog('Enter the new course title:', {
      title: 'Rename course',
      initial: course.title,
    });
    if (!title || title === course.title) return;
    try {
      await api(`/courses/${params.courseId}`, { method: 'PATCH', body: { title } });
      toast.success('Course renamed');
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to rename');
    }
  }

  async function deleteCourse() {
    if (!course) return;
    const ok = await confirmDialog(
      'This removes ALL sessions, recordings, and memberships. Cannot be undone.',
      {
        title: `Delete course "${course.title}"?`,
        confirmText: 'Delete',
        danger: true,
      },
    );
    if (!ok) return;
    try {
      await api(`/courses/${params.courseId}`, { method: 'DELETE' });
      toast.success('Course deleted');
      router.push('/courses');
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to delete');
    }
  }

  async function deleteSession(sessionId: string, title: string) {
    const ok = await confirmDialog(`This will remove "${title}" permanently.`, {
      title: 'Delete session?',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${sessionId}`, { method: 'DELETE' });
      toast.success('Session deleted');
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  async function renameSession(sessionId: string, currentTitle: string) {
    const title = await promptDialog('Enter the new session title:', {
      title: 'Rename session',
      initial: currentTitle,
    });
    if (!title || title === currentTitle) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${sessionId}`, {
        method: 'PATCH',
        body: { title },
      });
      toast.success('Session updated');
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  async function createSession(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title'));
    const description = String(form.get('description') ?? '').trim();
    const scheduledAtStr = String(form.get('scheduledAt') ?? '');
    const accessCode = String(form.get('accessCode') ?? '').trim();
    const body: any = { title };
    if (description) body.description = description;
    if (scheduledAtStr) body.scheduledAt = new Date(scheduledAtStr).toISOString();
    if (accessCode) {
      if (!/^\d{6}$/.test(accessCode)) {
        toast.error('Access code must be exactly 6 digits');
        return;
      }
      body.accessCode = accessCode;
    }
    try {
      await api(`/courses/${params.courseId}/sessions`, { method: 'POST', body });
      setCreating(false);
      toast.success(`Session "${title}" created`);
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  async function setSessionAccessCode(sessionId: string, currentCode: string | null) {
    const input = await promptDialog(
      'Enter exactly 6 digits, or leave blank to remove the code.',
      {
        title: currentCode ? 'Change access code' : 'Set access code',
        initial: currentCode ?? '',
        placeholder: '••••••',
        inputType: 'number',
        inputAttributes: { maxlength: '6' },
        validate: (v) => {
          const t = v.trim();
          if (!t) return null; // empty = clear
          if (!/^\d{6}$/.test(t)) return 'Must be exactly 6 digits';
          return null;
        },
      },
    );
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    try {
      await api(`/courses/${params.courseId}/sessions/${sessionId}`, {
        method: 'PATCH',
        body: { accessCode: trimmed || null },
      });
      toast.success(trimmed ? 'Access code saved' : 'Access code removed');
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  async function rotateJoinCode() {
    const ok = await confirmDialog(
      'The current join code will stop working immediately. Anyone you want to invite afterwards needs the new code.',
      { title: 'Rotate join code?', confirmText: 'Rotate', danger: true },
    );
    if (!ok) return;
    try {
      const r = await api<{ joinCode: string }>(
        `/courses/${params.courseId}/rotate-join-code`,
        { method: 'POST' },
      );
      toast.success(`New join code: ${r.joinCode}`);
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  async function toggleVisibility() {
    if (!course) return;
    const next =
      course.visibility === CourseVisibility.PRIVATE
        ? CourseVisibility.PUBLIC
        : CourseVisibility.PRIVATE;
    try {
      await api(`/courses/${params.courseId}`, {
        method: 'PATCH',
        body: { visibility: next },
      });
      toast.success(`Course is now ${next}`);
      reload();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  if (loading)
    return (
      <div className="p-6 flex flex-col gap-4 max-w-6xl">
        <Skeleton className="h-24" />
        <Skeleton className="h-60" />
      </div>
    );
  if (!course) return null;
  const isTeacher = course.myRole === CourseRole.TEACHER;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="border border-ink rounded p-4 flex gap-4 items-center flex-wrap">
        <div
          className="w-14 h-14 border border-ink rounded"
          style={{ background: course.coverColor ?? pickCourseCover(course.code) }}
        />
        <div className="flex-1 min-w-[300px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] px-1.5 py-0.5 bg-paper-alt border border-ink/30 rounded">
              {course.code}
            </span>
            <span
              className={[
                'text-[10px] font-bold px-1.5 py-0.5 rounded border',
                course.visibility === CourseVisibility.PUBLIC
                  ? 'bg-ok-soft text-ok border-ok'
                  : 'bg-paper-alt text-ink-soft border-ink/30',
              ].join(' ')}
            >
              {course.visibility}
            </span>
            {/* Copy public share link — teacher only, only when course is
                actually public (otherwise the link 403s for guests). */}
            {isTeacher && course.visibility === CourseVisibility.PUBLIC && (
              <button
                onClick={() => {
                  const url = `${window.location.origin}/join/${course.id}`;
                  navigator.clipboard.writeText(url);
                  toast.info('Copied public share link');
                }}
                title="Copy public share link (anyone can join as guest)"
                className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 bg-ok-soft text-ok border border-ok rounded hover:brightness-95"
              >
                🔗 Share link ⎘
              </button>
            )}
            {isTeacher && course.joinCode && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 bg-accent-soft text-accent border border-accent rounded">
                join: <b>{course.joinCode}</b>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(course.joinCode!);
                    toast.info('Copied join code');
                  }}
                  title="Copy"
                  className="hover:text-live"
                >
                  ⎘
                </button>
                <button onClick={rotateJoinCode} title="Rotate" className="hover:text-live">
                  ↻
                </button>
              </span>
            )}
          </div>
          <div className="font-bold text-xl mt-1">{course.title}</div>
          <div className="text-xs text-ink-soft">
            {course.description} · {course.sessionCount} sessions · {course.memberCount} members
          </div>
        </div>
        <div className="flex gap-2">
          {isTeacher && (
            <>
              <Button variant="ghost" onClick={toggleVisibility}>
                {course.visibility === CourseVisibility.PRIVATE ? '🌐 Make public' : '🔒 Make private'}
              </Button>
              <Button variant="ghost" onClick={renameCourse}>
                ✎ Rename
              </Button>
              <Button variant="ghost" onClick={deleteCourse}>
                ✕ Delete
              </Button>
              <Link href={`/courses/${course.id}/members`}>
                <Button variant="ghost">Members</Button>
              </Link>
              <Button variant="primary" onClick={() => setCreating((v) => !v)}>
                + New session
              </Button>
            </>
          )}
          {!isTeacher && course.myRole === null && (
            <span className="text-[11px] text-ink-mute font-mono">viewing as guest</span>
          )}
        </div>
      </div>

      <div className="flex gap-5 border-b border-ink">
        {(['sessions', 'members'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'py-2 -mb-px font-semibold capitalize',
              tab === t ? 'border-b-2 border-accent text-accent' : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {t}{' '}
            {t === 'sessions' && (
              <span className="ml-1 text-xs">({course.sessionCount})</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'sessions' && (
        <>
          <div className="flex gap-2 items-center flex-wrap">
            <div className="relative flex-1 max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute text-sm">⌕</span>
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="search sessions"
                className="h-9 pl-8 pr-3 w-full border border-ink rounded text-sm bg-paper"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 px-2 border border-ink rounded text-sm bg-paper"
            >
              <option value="">All statuses</option>
              <option value={SessionStatus.DRAFT}>Draft</option>
              <option value={SessionStatus.SCHEDULED}>Scheduled</option>
              <option value={SessionStatus.LIVE}>Live</option>
              <option value={SessionStatus.ENDED}>Ended</option>
            </select>
            <div className="flex-1" />
            <div className="flex border border-ink rounded overflow-hidden text-xs">
              {(['table', 'timeline', 'kanban'] as View[]).map((v, i) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={[
                    'px-3 h-9 capitalize font-semibold',
                    view === v ? 'bg-accent text-white' : 'bg-paper hover:bg-paper-alt',
                    i > 0 ? 'border-l border-ink' : '',
                  ].join(' ')}
                  title={`press ${i + 1}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <span className="text-[11px] font-mono text-ink-mute hidden lg:inline">
              <kbd className="px-1 border border-ink/30 rounded">1</kbd>{' '}
              <kbd className="px-1 border border-ink/30 rounded">2</kbd>{' '}
              <kbd className="px-1 border border-ink/30 rounded">3</kbd>
              {isTeacher && (
                <>
                  {' '}
                  · <kbd className="px-1 border border-ink/30 rounded">n</kbd> new
                </>
              )}
            </span>
          </div>

          {creating && (
            <form
              onSubmit={createSession}
              className="border border-ink rounded p-3 bg-paper-alt flex flex-col gap-2"
            >
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  name="title"
                  required
                  placeholder="Session title"
                  autoFocus
                  className="h-9 px-2 border border-ink rounded text-sm flex-1 min-w-[200px]"
                />
                <input
                  type="datetime-local"
                  name="scheduledAt"
                  className="h-9 px-2 border border-ink rounded text-sm"
                />
                <input
                  name="accessCode"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="6-digit code (optional)"
                  title="Optional 6-digit access code students enter before viewing"
                  className="h-9 px-2 border border-ink rounded text-sm w-[160px] font-mono"
                />
              </div>
              <textarea
                name="description"
                rows={2}
                maxLength={2000}
                placeholder="Description (optional) — what's this session about?"
                className="px-2 py-1.5 border border-ink rounded text-sm resize-y"
              />
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm">
                  Create
                </Button>
              </div>
            </form>
          )}

          {sessions.length === 0 ? (
            <div className="border border-dashed border-ink rounded p-8 text-center text-ink-soft text-sm">
              {q || statusFilter ? 'No sessions match your filter.' : 'No sessions yet.'}
            </div>
          ) : view === 'table' ? (
            <SessionTable
              sessions={sessions}
              course={course}
              onRename={renameSession}
              onDelete={deleteSession}
              onSetAccessCode={isTeacher ? setSessionAccessCode : undefined}
            />
          ) : view === 'timeline' ? (
            <SessionTimeline sessions={sessions} course={course} />
          ) : (
            <SessionKanban sessions={sessions} course={course} />
          )}
        </>
      )}

      {tab === 'members' && <CourseMembers courseId={course.id} canEdit={isTeacher} />}
    </div>
  );
}

function SessionTable({
  sessions,
  course,
  onRename,
  onDelete,
  onSetAccessCode,
}: {
  sessions: Session[];
  course: Course;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
  onSetAccessCode?: (id: string, currentCode: string | null) => void;
}) {
  const isTeacher = course.myRole === CourseRole.TEACHER;
  return (
    <div className="border border-ink rounded overflow-hidden">
      <div className="grid grid-cols-[40px_2.5fr_110px_90px_130px_150px] bg-paper-alt border-b border-ink text-[11px] font-semibold text-ink-soft">
        {['#', 'SESSION', 'WHEN', 'DURATION', 'STATUS', ''].map((h) => (
          <div key={h} className="p-2.5 border-l first:border-l-0 border-ink/20">
            {h}
          </div>
        ))}
      </div>
      {sessions.map((s, i) => {
        const kind = sessionStatusPillKind(s.status, s.recording?.status);
        return (
          <div
            key={s.id}
            className="grid grid-cols-[40px_2.5fr_110px_90px_130px_150px] border-b last:border-b-0 border-dashed border-ink/20 items-center text-sm min-h-[44px]"
          >
            <div className="p-2.5 font-mono text-[11px] text-ink-mute">S{i + 1}</div>
            <div className="p-2.5 font-semibold">{s.title}</div>
            <div className="p-2.5 text-xs text-ink-soft">
              {s.scheduledAt ? new Date(s.scheduledAt).toLocaleDateString() : '—'}
            </div>
            <div className="p-2.5 font-mono text-xs text-ink-soft">
              {fmtDuration(s.recording?.durationSec)}
            </div>
            <div className="p-2.5">
              <StatusPill kind={kind} />
            </div>
            <div className="p-2.5 flex gap-1.5 items-center">
              <SessionRowAction course={course} session={s} />
              {isTeacher && (
                <div className="flex gap-0.5 ml-1">
                  <button
                    onClick={() => onRename(s.id, s.title)}
                    title="Rename"
                    className="text-ink-mute hover:text-ink text-xs px-1"
                  >
                    ✎
                  </button>
                  {onSetAccessCode && (
                    <button
                      onClick={() => onSetAccessCode(s.id, s.accessCode ?? null)}
                      title={
                        s.accessCode
                          ? `Access code: ${s.accessCode} — click to change`
                          : 'No access code — click to set one'
                      }
                      className={
                        s.accessCode
                          ? 'text-warn hover:text-ink text-xs px-1'
                          : 'text-ink-mute hover:text-ink text-xs px-1'
                      }
                    >
                      {s.accessCode ? '🔐' : '🔓'}
                    </button>
                  )}
                  <button
                    onClick={() => onDelete(s.id, s.title)}
                    title="Delete"
                    className="text-ink-mute hover:text-live text-xs px-1"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionTimeline({ sessions, course }: { sessions: Session[]; course: Course }) {
  const sorted = [...sessions].sort((a, b) => {
    const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
    const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
    return ta - tb;
  });
  return (
    <div className="border-l-2 border-ink pl-6 flex flex-col gap-3 ml-2">
      {sorted.map((s, i) => {
        const kind = sessionStatusPillKind(s.status, s.recording?.status);
        const isLive = s.status === SessionStatus.LIVE;
        const isReady = s.recording?.status === RecordingStatus.READY;
        return (
          <div key={s.id} className="relative">
            <div
              className={[
                'absolute -left-[30px] top-3 w-3.5 h-3.5 rounded-full border-2',
                isLive
                  ? 'bg-live border-live animate-blink'
                  : isReady
                    ? 'bg-ok border-ok'
                    : 'bg-paper border-ink',
              ].join(' ')}
            />
            <div className="border border-ink rounded p-3 flex gap-3 items-center">
              <div className="flex-1 min-w-0">
                <div className="flex gap-2 items-center">
                  <span className="font-mono text-[11px] text-ink-mute">
                    S{i + 1} ·{' '}
                    {s.scheduledAt ? new Date(s.scheduledAt).toLocaleDateString() : 'anytime'}
                  </span>
                  <StatusPill kind={kind} small />
                </div>
                <div className="font-bold text-sm mt-0.5">{s.title}</div>
              </div>
              <SessionRowAction course={course} session={s} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionKanban({ sessions, course }: { sessions: Session[]; course: Course }) {
  const cols: { key: string; label: string; match: (s: Session) => boolean }[] = [
    { key: SessionStatus.DRAFT, label: 'Draft', match: (s) => s.status === SessionStatus.DRAFT },
    { key: SessionStatus.SCHEDULED, label: 'Scheduled', match: (s) => s.status === SessionStatus.SCHEDULED },
    { key: SessionStatus.LIVE, label: 'Live', match: (s) => s.status === SessionStatus.LIVE },
    {
      key: RecordingStatus.PROCESSING,
      label: 'Processing',
      match: (s) => s.recording?.status === RecordingStatus.PROCESSING,
    },
    { key: RecordingStatus.READY, label: 'Ready', match: (s) => s.recording?.status === RecordingStatus.READY },
  ];
  return (
    <div className="grid grid-cols-5 gap-3 min-h-[400px]">
      {cols.map((col) => {
        const items = sessions.filter(col.match);
        return (
          <div
            key={col.key}
            className="border border-ink bg-paper-alt rounded p-2 flex flex-col gap-2"
          >
            <div className="flex justify-between items-center px-1">
              <StatusPill kind={col.key.toLowerCase() as any} small />
              <span className="font-mono text-[10px] text-ink-mute">{items.length}</span>
            </div>
            {items.map((s) => (
              <Link
                key={s.id}
                href={
                  course.myRole === CourseRole.TEACHER &&
                  s.status !== SessionStatus.ENDED &&
                  s.recording?.status !== RecordingStatus.READY
                    ? `/courses/${course.id}/sessions/${s.id}/record`
                    : `/courses/${course.id}/sessions/${s.id}`
                }
                className="bg-paper border border-ink rounded p-2 hover:shadow-[2px_2px_0_rgba(0,0,0,0.08)]"
              >
                <div className="font-mono text-[10px] text-ink-mute">
                  {s.scheduledAt ? new Date(s.scheduledAt).toLocaleDateString() : '—'}
                </div>
                <div className="font-bold text-xs leading-snug line-clamp-2">{s.title}</div>
              </Link>
            ))}
            {items.length === 0 && (
              <div className="text-[11px] text-ink-mute text-center py-4">—</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SessionRowAction({ course, session }: { course: Course; session: Session }) {
  const isTeacher = course.myRole === CourseRole.TEACHER;
  const recStatus = session.recording?.status;
  if (session.status === SessionStatus.LIVE) {
    return isTeacher ? (
      <Link href={`/courses/${course.id}/sessions/${session.id}/record`}>
        <Button variant="live" size="sm">
          Live
        </Button>
      </Link>
    ) : (
      <Link href={`/courses/${course.id}/sessions/${session.id}`}>
        <Button variant="live" size="sm">
          ● Join live
        </Button>
      </Link>
    );
  }
  if (recStatus === RecordingStatus.READY)
    return (
      <Link href={`/courses/${course.id}/sessions/${session.id}`}>
        <Button variant="ghost" size="sm">
          Watch
        </Button>
      </Link>
    );
  if (recStatus === RecordingStatus.PROCESSING)
    return (
      <Link href={`/courses/${course.id}/sessions/${session.id}`}>
        <Button variant="ghost" size="sm">
          …
        </Button>
      </Link>
    );
  if (isTeacher)
    return (
      <Link href={`/courses/${course.id}/sessions/${session.id}/record`}>
        <Button variant="primary" size="sm">
          Start
        </Button>
      </Link>
    );
  return <span className="text-[11px] text-ink-mute">soon</span>;
}

function CourseMembers({ courseId, canEdit }: { courseId: string; canEdit: boolean }) {
  const [members, setMembers] = useState<
    { userId: string; name: string; email: string; role: CourseRole }[]
  >([]);
  const toast = useToast();
  useEffect(() => {
    api(`/courses/${courseId}/members`).then(setMembers).catch(() => {});
  }, [courseId]);
  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    try {
      await api(`/courses/${courseId}/members`, {
        method: 'POST',
        body: { email, role: String(form.get('role')) },
      });
      (e.currentTarget as HTMLFormElement).reset();
      setMembers(await api(`/courses/${courseId}/members`));
      toast.success(`Added ${email}`);
    } catch (err: any) {
      toast.error(err?.body?.error ?? 'failed to add');
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <form
          onSubmit={invite}
          className="border border-dashed border-ink rounded p-3 flex gap-2 items-center"
        >
          <input
            name="email"
            type="email"
            required
            placeholder="email to add"
            className="h-9 px-2 border border-ink rounded text-sm flex-1"
          />
          <select
            name="role"
            className="h-9 px-2 border border-ink rounded text-sm"
            defaultValue={CourseRole.STUDENT}
          >
            <option value={CourseRole.STUDENT}>{CourseRole.STUDENT}</option>
            <option value={CourseRole.TEACHER}>{CourseRole.TEACHER}</option>
          </select>
          <Button type="submit" variant="primary" size="sm">
            Add member
          </Button>
        </form>
      )}
      <div className="border border-ink rounded overflow-hidden">
        <div className="grid grid-cols-[2fr_2fr_100px] bg-paper-alt border-b border-ink text-[11px] font-semibold text-ink-soft">
          <div className="p-2.5">NAME</div>
          <div className="p-2.5 border-l border-ink/20">EMAIL</div>
          <div className="p-2.5 border-l border-ink/20">ROLE</div>
        </div>
        {members.map((m) => (
          <div
            key={m.userId}
            className="grid grid-cols-[2fr_2fr_100px] border-b last:border-b-0 border-dashed border-ink/20 items-center text-sm"
          >
            <div className="p-2.5 font-semibold">{m.name}</div>
            <div className="p-2.5 font-mono text-xs text-ink-soft">{m.email}</div>
            <div className="p-2.5 text-[11px] font-bold">{m.role}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
