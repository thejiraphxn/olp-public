'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ token: string }>('/auth/register', {
        method: 'POST',
        body: { name, email, password },
      });
      if (r?.token) sessionStorage.setItem('olp_socket_token', r.token);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e?.body?.error ?? 'failed');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper-alt flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-paper border border-ink rounded p-8 shadow-[3px_3px_0_rgba(0,0,0,0.08)]">
        <div className="font-bold text-lg flex items-center gap-2">
          <span>◐</span> Create your account
        </div>
        <p className="text-sm text-ink-soft mt-1">
          Start teaching or enroll in a course. You can always be promoted to teacher inside a course.
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-3 mt-6">
          <input
            required
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-10 border border-ink rounded px-3 text-sm bg-paper"
          />
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
            minLength={8}
            placeholder="password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 border border-ink rounded px-3 text-sm bg-paper"
          />
          {err && <div className="text-xs text-live">{err}</div>}
          <Button variant="primary" size="lg" type="submit" disabled={loading}>
            {loading ? 'Creating…' : 'Create account →'}
          </Button>
        </form>

        <div className="text-xs text-ink-soft text-center mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-accent underline">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
