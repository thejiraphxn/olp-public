'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';

type GuestResponse = {
  token: string;
  user: {
    id: string;
    name: string;
    isGuest: true;
    course: { id: string; code: string; title: string };
  };
};

/**
 * Public, no-auth-required entry point. Shared via URL like
 *   /join/<courseId>?sessionId=<id>
 * The optional `sessionId` query param sends the guest straight to the live
 * session after joining; without it we drop them on the course page.
 *
 * Backend gates this to PUBLIC courses only — a private course id will get
 * a 404 from /auth/guest.
 */
export default function GuestJoinPage({
  params,
}: {
  params: { courseId: string };
}) {
  const router = useRouter();
  const search = useSearchParams();
  const sessionId = search.get('sessionId');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function join() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<GuestResponse>('/auth/guest', {
        method: 'POST',
        body: { courseId: params.courseId, name: name.trim() || undefined },
      });
      // Mirror what login does — sock.io can fall back to this if the cookie
      // doesn't ride the cross-origin handshake.
      if (r?.token) sessionStorage.setItem('olp_socket_token', r.token);
      router.push(
        sessionId
          ? `/courses/${params.courseId}/sessions/${sessionId}`
          : `/courses/${params.courseId}`,
      );
    } catch (e: any) {
      const status = e?.status;
      setErr(
        status === 404
          ? "This course isn't public — ask the teacher for an invite."
          : status === 429
            ? 'Too many attempts. Wait a moment and try again.'
            : e?.body?.error ?? 'Something went wrong.',
      );
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md border border-ink rounded p-6 bg-paper-alt shadow-[3px_3px_0_rgba(0,0,0,0.08)]">
        <div className="text-[11px] font-mono text-ink-mute mb-1">JOIN AS GUEST</div>
        <h1 className="text-xl font-bold mb-2">Watch a public class</h1>
        <p className="text-xs text-ink-soft mb-4">
          You'll join read-only — you can watch the live stream and recordings,
          but won't be able to chat, ask questions, or raise your hand.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading) join();
          }}
          className="flex flex-col gap-3"
        >
          <label className="text-xs font-semibold text-ink-soft">
            Display name <span className="text-ink-mute font-normal">(optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="e.g. Alex from Acme"
              className="mt-1 w-full h-10 px-3 border border-ink rounded text-sm bg-paper"
            />
            <span className="block text-[10px] text-ink-mute mt-1">
              We'll add &quot;(guest)&quot; after your name so others can tell you're not signed in.
            </span>
          </label>

          {err && (
            <div className="border border-live bg-live-soft text-live text-xs px-3 py-2 rounded">
              {err}
            </div>
          )}

          <Button type="submit" variant="primary" disabled={loading}>
            {loading ? 'Joining…' : '→ Join class'}
          </Button>
        </form>

        <div className="mt-4 pt-4 border-t border-ink/30 text-xs text-ink-soft flex items-center justify-between">
          <span>Have an account?</span>
          <Link href="/login" className="font-semibold text-accent hover:underline">
            Sign in →
          </Link>
        </div>
      </div>
    </div>
  );
}
