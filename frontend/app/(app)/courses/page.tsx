'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, qs, type Paginated } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { RoleBadge } from '@/components/ui/RoleBadge';
import { useToast } from '@/components/ui/Toast';
import { Skeleton } from '@/components/ui/Skeleton';
import type { CourseRole } from '@/lib/enums';

type Course = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  sessionCount: number;
  memberCount: number;
  myRole: CourseRole;
};

export default function CoursesPage() {
  const [data, setData] = useState<Paginated<Course> | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const toast = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const resp = await api<Paginated<Course>>(`/courses${qs({ q, page, limit: 20 })}`);
      setData(resp);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load courses');
      setData({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 });
    }
  }

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0); // debounce search
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setCreating(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function createCourse(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      code: String(form.get('code')),
      title: String(form.get('title')),
      description: String(form.get('description') ?? ''),
    };
    try {
      const created = await api<Course>('/courses', { method: 'POST', body });
      setCreating(false);
      toast.success(`Course ${created.code} created`);
      load();
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to create');
    }
  }

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">My Courses</h1>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>
          + New course
        </Button>
      </div>

      <div className="flex gap-2 items-center">
        <div className="relative flex-1 max-w-md">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute text-sm">⌕</span>
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="search courses — press / to focus"
            className="h-9 pl-8 pr-3 w-full border border-ink rounded text-sm bg-paper"
          />
        </div>
        {data && (
          <span className="text-[11px] font-mono text-ink-mute">
            {data.total} course{data.total === 1 ? '' : 's'}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-ink-mute">
          keys: <kbd className="px-1 border border-ink/30 rounded">n</kbd> new ·{' '}
          <kbd className="px-1 border border-ink/30 rounded">/</kbd> search
        </span>
      </div>

      {creating && (
        <form
          onSubmit={createCourse}
          className="border border-ink rounded p-4 bg-paper-alt flex flex-col gap-2"
        >
          <div className="grid grid-cols-[120px_1fr] gap-3">
            <input
              name="code"
              required
              placeholder="ENG-101"
              className="h-9 px-2 border border-ink rounded text-sm font-mono"
            />
            <input
              name="title"
              required
              placeholder="Course title"
              className="h-9 px-2 border border-ink rounded text-sm"
            />
          </div>
          <textarea
            name="description"
            rows={2}
            placeholder="One-line description"
            className="p-2 border border-ink rounded text-sm"
          />
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </div>
        </form>
      )}

      {data === null ? (
        <div className="flex flex-col gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="border border-dashed border-ink rounded p-10 text-center text-ink-soft">
          {q ? `No courses match "${q}"` : 'No courses yet. Create your first course above.'}
        </div>
      ) : (
        <>
          <div className="border border-ink rounded overflow-hidden">
            <div className="grid grid-cols-[1.5fr_2fr_80px_90px_90px_90px] bg-paper-alt border-b border-ink text-[11px] font-semibold text-ink-soft">
              {['CODE', 'TITLE', 'ROLE', 'SESSIONS', 'MEMBERS', ''].map((h) => (
                <div key={h} className="p-2.5 border-l first:border-l-0 border-ink/20">
                  {h}
                </div>
              ))}
            </div>
            {data.items.map((c) => (
              <div
                key={c.id}
                className="grid grid-cols-[1.5fr_2fr_80px_90px_90px_90px] border-b last:border-b-0 border-dashed border-ink/20 items-center text-sm"
              >
                <div className="p-2.5 font-mono text-xs">{c.code}</div>
                <div className="p-2.5 font-semibold">{c.title}</div>
                <div className="p-2.5">
                  <RoleBadge role={c.myRole} />
                </div>
                <div className="p-2.5 font-mono text-xs">{c.sessionCount}</div>
                <div className="p-2.5 font-mono text-xs">{c.memberCount}</div>
                <div className="p-2.5">
                  <Link href={`/courses/${c.id}`}>
                    <Button variant="ghost" size="sm">
                      Open →
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
          {data.totalPages > 1 && (
            <div className="flex justify-end gap-2 items-center text-xs">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-7 px-2 border border-ink rounded disabled:opacity-30"
              >
                ←
              </button>
              <span className="font-mono text-ink-mute">
                page {data.page} / {data.totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                className="h-7 px-2 border border-ink rounded disabled:opacity-30"
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
