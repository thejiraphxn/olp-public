'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { RoleBadge } from '@/components/ui/RoleBadge';
import { api } from '@/lib/api';
import { CourseRole } from '@/lib/enums';

type DemoPersona = {
  name: string;
  email: string;
  blurb: string | null;
  role: CourseRole;
};

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('demo1234');
  const [personas, setPersonas] = useState<DemoPersona[] | null>(null);

  useEffect(() => {
    api<DemoPersona[]>('/auth/demo/list')
      .then(setPersonas)
      .catch(() => setPersonas([]));
  }, []);

  async function switchTo(email: string) {
    setLoading(email);
    setErr(null);
    try {
      const r = await api<{ token: string }>('/auth/demo/switch', {
        method: 'POST',
        body: { email },
      });
      if (r?.token) sessionStorage.setItem('olp_socket_token', r.token);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e?.body?.error ?? 'failed');
      setLoading(null);
    }
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading('pw');
    setErr(null);
    try {
      const r = await api<{ token: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (r?.token) sessionStorage.setItem('olp_socket_token', r.token);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e?.body?.error ?? 'invalid credentials');
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-paper-alt flex items-center justify-center p-6">
      <div className="w-full max-w-2xl bg-paper border border-ink rounded p-8 shadow-[3px_3px_0_rgba(0,0,0,0.08)]">
        <div className="flex items-center justify-between mb-1">
          <div className="font-bold text-lg flex items-center gap-2">
            <span>◐</span> Online Learning Platform
          </div>
          <span className="text-[11px] font-mono text-ink-mute">v0.1 demo</span>
        </div>
        <h1 className="text-2xl font-bold mt-4">Sign in</h1>
        <p className="text-sm text-ink-soft">
          Pick a persona to walk through the product. No auth needed in demo mode.
        </p>

        {personas === null ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
            {[...Array(4)].map((_, i) => (
              <div
                key={i}
                className="h-14 border border-ink/20 rounded bg-paper-alt animate-pulse"
              />
            ))}
          </div>
        ) : personas.length === 0 ? (
          <div className="border border-dashed border-ink rounded p-4 mt-6 text-center text-xs text-ink-mute">
            No demo personas are seeded. Sign in with email/password below, or run{' '}
            <code className="font-mono">pnpm seed</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
            {personas.map((p) => (
              <button
                key={p.email}
                onClick={() => switchTo(p.email)}
                disabled={!!loading}
                className="flex items-center gap-3 p-3 border border-ink rounded text-left hover:bg-accent-soft/50 transition-colors disabled:opacity-50"
              >
                <Avatar name={p.name} size={36} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm truncate">{p.name}</span>
                    <RoleBadge role={p.role} />
                  </div>
                  <div className="text-xs text-ink-soft truncate">
                    {p.blurb ?? p.email}
                  </div>
                </div>
                <span className="text-ink-mute">{loading === p.email ? '…' : '›'}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-ink/20" />
          <span className="text-[11px] font-mono text-ink-mute">or sign in with email</span>
          <div className="flex-1 h-px bg-ink/20" />
        </div>

        <form onSubmit={onLogin} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 border border-ink rounded px-3 text-sm bg-paper"
            />
            <input
              type="password"
              required
              placeholder="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 border border-ink rounded px-3 text-sm bg-paper"
            />
          </div>
          {err && <div className="text-xs text-live">{err}</div>}
          <Button variant="primary" size="lg" type="submit" disabled={!!loading}>
            {loading === 'pw' ? 'Signing in…' : 'Sign in →'}
          </Button>
          <p className="text-[11px] font-mono text-ink-mute text-center">
            seeded password for every account: <b>demo1234</b>
          </p>
        </form>

        <div className="text-xs text-ink-soft text-center mt-6">
          New here?{' '}
          <Link href="/register" className="text-accent underline">
            Create an account
          </Link>
        </div>
      </div>
    </div>
  );
}
