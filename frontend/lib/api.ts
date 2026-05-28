import type { CourseRole } from './enums';

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';

type ApiInit = Omit<RequestInit, 'body'> & {
  // Allow any JSON-serializable body; our helper stringifies for you.
  body?: unknown;
};

// Optional 6-digit session access codes are stashed in sessionStorage by
// the gate-modal flow on the session page. Anything that hits a
// session-scoped path picks the matching code up and forwards it as the
// `X-Session-Code` header so the backend `requireSessionAccess` middleware
// is happy.
const SESSION_CODE_PREFIX = 'olp_session_code:';

export function setSessionCode(sessionId: string, code: string | null) {
  if (typeof window === 'undefined') return;
  const key = SESSION_CODE_PREFIX + sessionId;
  if (!code) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, code);
}

export function getSessionCode(sessionId: string): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(SESSION_CODE_PREFIX + sessionId);
}

function autoSessionCodeHeader(path: string): Record<string, string> {
  // Path shape we care about: `/courses/:cid/sessions/:sid/...`
  const m = path.match(/\/sessions\/([^/?#]+)/);
  if (!m) return {};
  const code = getSessionCode(m[1]);
  return code ? { 'X-Session-Code': code } : {};
}

export async function api<T = any>(path: string, init: ApiInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const payload =
    body === undefined || body === null
      ? undefined
      : typeof body === 'string' || body instanceof FormData || body instanceof Blob
        ? (body as BodyInit)
        : JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      // Only set JSON content-type when we're actually sending JSON.
      ...(payload && typeof payload === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...autoSessionCodeHeader(path),
      ...(headers ?? {}),
    },
    body: payload,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(
      `API ${res.status} ${rest.method ?? 'GET'} ${path}${
        body?.error ? ` — ${body.error}` : ''
      }`,
    );
    err.status = res.status;
    err.body = body;
    err.path = path;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type Me = {
  id: string;
  // null for guest sessions (no real account).
  email: string | null;
  name: string;
  // Set when this session was created via /auth/guest. Use it to gate UI
  // affordances that don't make sense for anonymous viewers (sending chat,
  // asking questions, raising hand, etc.).
  isGuest?: boolean;
  memberships: {
    courseId: string;
    role: CourseRole;
    course: { id: string; code: string; title: string };
  }[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export function qs(params: Record<string, string | number | undefined | null>) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.length === 0) return '';
  return '?' + new URLSearchParams(clean.map(([k, v]) => [k, String(v)])).toString();
}
