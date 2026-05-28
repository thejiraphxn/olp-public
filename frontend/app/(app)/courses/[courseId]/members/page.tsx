'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialog';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { RoleBadge } from '@/components/ui/RoleBadge';
import { CourseRole } from '@/lib/enums';

type Member = { userId: string; name: string; email: string; role: CourseRole };

export default function MembersPage({ params }: { params: { courseId: string } }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState<CourseRole | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function reload() {
    const [ms, course] = await Promise.all([
      api<Member[]>(`/courses/${params.courseId}/members`),
      api<any>(`/courses/${params.courseId}`),
    ]);
    setMembers(ms);
    setMyRole(course.myRole);
  }
  useEffect(() => {
    reload();
  }, [params.courseId]);

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const form = new FormData(e.currentTarget);
    try {
      await api(`/courses/${params.courseId}/members`, {
        method: 'POST',
        body: { email: String(form.get('email')), role: String(form.get('role')) },
      });
      (e.currentTarget as HTMLFormElement).reset();
      reload();
    } catch (err: any) {
      setErr(err?.body?.error ?? 'failed');
    }
  }

  async function remove(userId: string) {
    const ok = await confirmDialog('They will lose access to this course immediately.', {
      title: 'Remove member?',
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await api(`/courses/${params.courseId}/members/${userId}`, { method: 'DELETE' });
    reload();
  }

  return (
    <div className="p-6 flex flex-col gap-4 max-w-5xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Members</h1>
          <div className="text-xs text-ink-soft">
            {members.filter((m) => m.role === CourseRole.TEACHER).length} teacher ·{' '}
            {members.filter((m) => m.role === CourseRole.STUDENT).length} students
          </div>
        </div>
        <Button variant="ghost" onClick={() => router.back()}>
          ← back
        </Button>
      </div>
      {myRole === CourseRole.TEACHER && (
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
            Add
          </Button>
        </form>
      )}
      {err && <div className="text-sm text-live">{err}</div>}
      <div className="border border-ink rounded overflow-hidden">
        <div className="grid grid-cols-[40px_2fr_2fr_100px_80px] bg-paper-alt border-b border-ink text-[11px] font-semibold text-ink-soft">
          <div className="p-2.5"></div>
          <div className="p-2.5 border-l border-ink/20">NAME</div>
          <div className="p-2.5 border-l border-ink/20">EMAIL</div>
          <div className="p-2.5 border-l border-ink/20">ROLE</div>
          <div className="p-2.5 border-l border-ink/20"></div>
        </div>
        {members.map((m) => (
          <div
            key={m.userId}
            className="grid grid-cols-[40px_2fr_2fr_100px_80px] border-b last:border-b-0 border-dashed border-ink/20 items-center text-sm"
          >
            <div className="p-2">
              <Avatar name={m.name} size={26} />
            </div>
            <div className="p-2.5 font-semibold">{m.name}</div>
            <div className="p-2.5 font-mono text-xs text-ink-soft">{m.email}</div>
            <div className="p-2.5">
              <RoleBadge role={m.role} />
            </div>
            <div className="p-2.5">
              {myRole === CourseRole.TEACHER && (
                <button
                  onClick={() => remove(m.userId)}
                  className="text-xs text-live hover:underline"
                >
                  remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
