'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from './Shell';
import { api, type Me } from '@/lib/api';
import { ToastProvider } from '@/components/ui/Toast';

/**
 * Pick the right redirect when /auth/me fails. For deep links into a
 * PUBLIC course (e.g. `/courses/<id>/sessions/<id>`) we send anonymous
 * visitors to the guest-join page, not the login wall — that way a
 * shared classroom link "just works" for anyone, the way Google Meet does.
 *
 * The PUBLIC check happens server-side at /auth/guest; if the course is
 * private, the guest-join call returns 404 and the user can fall back to
 * signing in from there.
 */
function fallbackRoute(): string {
  if (typeof window === 'undefined') return '/login';
  const path = window.location.pathname;
  const courseMatch = path.match(/^\/courses\/([^\/]+)/);
  if (!courseMatch) return '/login';
  const courseId = courseMatch[1];
  const sessionMatch = path.match(/\/sessions\/([^\/]+)/);
  const sessionId = sessionMatch?.[1];
  return sessionId
    ? `/join/${courseId}?sessionId=${sessionId}`
    : `/join/${courseId}`;
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.push(fallbackRoute()))
      .finally(() => setReady(true));
  }, [router]);

  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center text-ink-soft text-sm">
        Loading…
      </div>
    );
  }
  if (!me) return null;
  return (
    <ToastProvider>
      <Shell me={me}>{children}</Shell>
    </ToastProvider>
  );
}
