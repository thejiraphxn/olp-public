'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type Me, type Paginated } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { StatusPill, sessionStatusPillKind } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useRouter } from 'next/navigation';
import { CourseRole, SessionStatus, pickCourseCover } from '@/lib/enums';

type Course = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  coverColor: string | null;
  sessionCount: number;
  memberCount: number;
  myRole: CourseRole;
};

type Session = {
  id: string;
  courseId: string;
  title: string;
  status: string;
  scheduledAt: string | null;
  recording: null | { id: string; status: string; durationSec: number | null };
};

type ContinueItem = {
  sessionId: string;
  courseId: string;
  title: string;
  positionSec: number;
  durationSec: number | null;
  status: string;
  course: { id: string; code: string; title: string };
  updatedAt: string;
};

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [nextSession, setNextSession] = useState<{ course: Course; session: Session } | null>(
    null,
  );
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function joinByCode(e: React.FormEvent) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setJoining(true);
    try {
      const r = await api<{ courseId: string; code: string; title: string }>(
        '/courses/join',
        { method: 'POST', body: { code: joinCode.trim() } },
      );
      toast.success(`Joined ${r.code} — ${r.title}`);
      router.push(`/courses/${r.courseId}`);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'invalid code');
    } finally {
      setJoining(false);
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const meData = await api<Me>('/auth/me');
        if (!alive) return;
        setMe(meData);
        const csResp = await api<Paginated<Course>>('/courses?limit=100');
        const cs = csResp.items;
        if (!alive) return;
        setCourses(cs);

        try {
          const cont = await api<ContinueItem[]>('/progress/continue');
          if (alive) setContinueItems(cont);
        } catch {}

        const all = await Promise.all(
          cs.map(async (c) => ({
            course: c,
            sessions: (await api<Paginated<Session>>(`/courses/${c.id}/sessions?limit=100`)).items,
          })),
        );
        const now = Date.now();
        const upcoming = all
          .flatMap(({ course, sessions }) => sessions.map((s) => ({ course, session: s })))
          .filter(({ session }) => {
            if (session.status === SessionStatus.LIVE) return true;
            if (!session.scheduledAt) return false;
            return new Date(session.scheduledAt).getTime() >= now - 15 * 60 * 1000;
          })
          .sort(
            (a, b) =>
              new Date(a.session.scheduledAt ?? 0).getTime() -
              new Date(b.session.scheduledAt ?? 0).getTime(),
          );
        if (!alive) return;
        setNextSession(upcoming[0] ?? null);
      } catch (e: any) {
        toast.error(e?.body?.error ?? 'failed to load dashboard');
        setCourses([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me || courses === null)
    return (
      <div className="p-6 flex flex-col gap-5 max-w-6xl">
        <Skeleton className="h-10 w-80" />
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );

  const isTeacher = courses.some((c) => c.myRole === CourseRole.TEACHER);
  const firstName = me.name.split(' ')[0];

  return (
    <div className="p-6 flex flex-col gap-5 max-w-6xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">
            {isTeacher ? `Good morning, ${firstName} 👋` : `Welcome back, ${firstName}`}
          </h1>
          <p className="text-sm text-ink-soft">
            {isTeacher
              ? nextSession
                ? 'You have an upcoming session.'
                : 'Nothing scheduled — time to create a session.'
              : 'Pick up where you left off.'}
          </p>
        </div>
        {isTeacher && (
          <Link href="/courses">
            <Button variant="primary">+ New course</Button>
          </Link>
        )}
      </div>

      {isTeacher && (
        <div className="grid grid-cols-4 gap-3">
          {[
            ['COURSES', courses.filter((c) => c.myRole === CourseRole.TEACHER).length],
            ['SESSIONS', courses.reduce((s, c) => s + c.sessionCount, 0)],
            ['STUDENTS', courses.reduce((s, c) => s + c.memberCount, 0)],
            ['ENROLLED', courses.filter((c) => c.myRole === CourseRole.STUDENT).length],
          ].map(([l, v]) => (
            <div key={String(l)} className="border border-ink rounded p-3">
              <div className="text-[11px] text-ink-soft font-semibold">{l}</div>
              <div className="text-2xl font-bold">{v}</div>
            </div>
          ))}
        </div>
      )}

      {nextSession && (
        <div className="border border-accent bg-accent-soft rounded p-3.5 flex items-center gap-4">
          <div className="w-11 h-11 border border-accent bg-paper flex items-center justify-center rounded">
            ▷
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-sm">
                {nextSession.course.code} · {nextSession.session.title}
              </span>
              <StatusPill
                kind={sessionStatusPillKind(
                  nextSession.session.status,
                  nextSession.session.recording?.status,
                )}
              />
            </div>
            <div className="text-xs text-ink-soft">
              {nextSession.session.scheduledAt
                ? new Date(nextSession.session.scheduledAt).toLocaleString()
                : 'any time'}
            </div>
          </div>
          <Link
            href={`/courses/${nextSession.course.id}/sessions/${nextSession.session.id}${
              nextSession.course.myRole === CourseRole.TEACHER ? '/record' : ''
            }`}
          >
            <Button
              variant={
                nextSession.session.status === SessionStatus.LIVE ? 'live' : 'primary'
              }
            >
              {nextSession.course.myRole === CourseRole.TEACHER
                ? nextSession.session.status === SessionStatus.LIVE
                  ? 'Continue teaching →'
                  : 'Start teaching →'
                : nextSession.session.status === SessionStatus.LIVE
                  ? '● Join live →'
                  : 'Watch →'}
            </Button>
          </Link>
        </div>
      )}

      {continueItems.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">Continue watching</h2>
          <div className="grid grid-cols-2 gap-3">
            {continueItems.slice(0, 4).map((it) => {
              const pct =
                it.durationSec && it.durationSec > 0
                  ? Math.min(100, Math.round((it.positionSec / it.durationSec) * 100))
                  : 0;
              return (
                <Link
                  key={it.sessionId}
                  href={`/courses/${it.courseId}/sessions/${it.sessionId}`}
                  className="border border-ink rounded overflow-hidden flex gap-3 p-3 hover:shadow-[3px_3px_0_rgba(0,0,0,0.08)]"
                >
                  <div className="w-24 h-14 bg-zinc-900 text-white text-xs flex items-center justify-center rounded flex-shrink-0">
                    ▶
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-mono text-ink-mute">
                      {it.course.code}
                    </div>
                    <div className="font-bold text-sm truncate">{it.title}</div>
                    <div className="h-1.5 bg-paper-alt border border-ink/10 rounded mt-1.5 overflow-hidden">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[10px] font-mono text-ink-mute mt-0.5">
                      {pct}% watched
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <form
        onSubmit={joinByCode}
        className="border border-dashed border-ink rounded p-3 flex gap-2 items-center"
      >
        <span className="text-sm font-semibold text-ink-soft">Join with code:</span>
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="ENG101-JOIN"
          className="h-9 px-2 border border-ink rounded text-sm font-mono flex-1 max-w-xs uppercase"
        />
        <Button type="submit" variant="primary" size="sm" disabled={joining || !joinCode.trim()}>
          {joining ? 'Joining…' : 'Join'}
        </Button>
      </form>

      <h2 className="text-lg font-bold">{isTeacher ? 'Your courses' : 'My courses'}</h2>
      <div className="grid grid-cols-3 gap-4">
        {courses.map((c) => (
          <CourseCard key={c.id} course={c} />
        ))}
        {courses.length === 0 && (
          <div className="col-span-3 border border-dashed border-ink rounded p-10 text-center text-ink-soft">
            No courses yet. Head to <Link href="/courses" className="text-accent underline">My Courses</Link> to create one.
          </div>
        )}
      </div>
    </div>
  );
}

function CourseCard({ course }: { course: Course }) {
  const color = course.coverColor ?? pickCourseCover(course.code);
  return (
    <Link
      href={`/courses/${course.id}`}
      className="border border-ink rounded overflow-hidden flex flex-col hover:shadow-[3px_3px_0_rgba(0,0,0,0.08)] transition-shadow"
    >
      <div
        className="h-14 border-b border-ink relative"
        style={{ background: color }}
      >
        <span className="absolute top-2 left-2 font-mono text-[11px] bg-paper px-1.5 py-0.5 rounded">
          {course.code}
        </span>
      </div>
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <div className="font-bold text-sm leading-tight">{course.title}</div>
        <div className="text-xs text-ink-soft line-clamp-2 min-h-[32px]">
          {course.description}
        </div>
        <div className="flex gap-3 text-[11px] text-ink-mute font-mono mt-1">
          <span>▷ {course.sessionCount} sessions</span>
          <span>◈ {course.memberCount}</span>
        </div>
      </div>
    </Link>
  );
}
