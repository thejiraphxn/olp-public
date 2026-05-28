'use client';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './live-types';

/**
 * Socket.IO connects to the backend.
 *
 * Next.js dev server's `rewrites()` cannot forward WebSocket upgrade
 * handshakes, so in dev we MUST bypass the proxy and talk to the backend
 * directly. We derive the backend URL from a few sources, in order:
 *
 *   1. NEXT_PUBLIC_SOCKET_URL       (explicit override — dev or prod)
 *   2. NEXT_PUBLIC_API_BASE         (if absolute, strip the /api/v1 path)
 *   3. same-origin                  (only works behind a WS-aware proxy:
 *                                    nginx, caddy, cloudflared tunnel, etc.)
 *
 * For production deploys behind a reverse proxy that DOES proxy WS, set
 * NEXT_PUBLIC_SOCKET_URL to an empty string (explicit blank) and both
 * the API and the socket will talk to the same origin.
 */
export type OLPSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function socketTarget(): string | undefined {
  const explicit = process.env.NEXT_PUBLIC_SOCKET_URL;
  if (explicit !== undefined) {
    // Empty = explicit "same-origin" (prod with WS-aware proxy).
    return explicit.trim() || undefined;
  }
  // Derive from API base when it's absolute.
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';
  if (/^https?:\/\//i.test(apiBase)) {
    try {
      const u = new URL(apiBase);
      return `${u.protocol}//${u.host}`;
    } catch {}
  }
  // Fallback: same-origin. Requires a reverse proxy that handles WS upgrade.
  return undefined;
}

export async function connectSocket(sessionId?: string): Promise<OLPSocket> {
  const token =
    typeof window !== 'undefined'
      ? sessionStorage.getItem('olp_socket_token') ?? ''
      : '';
  // Optional 6-digit code stashed by the gate modal on the session page.
  // The server checks this on `room:join` for sessions that have a code.
  const sessionCode =
    sessionId && typeof window !== 'undefined'
      ? sessionStorage.getItem('olp_session_code:' + sessionId) ?? ''
      : '';
  const target = socketTarget();
  const opts = {
    path: '/socket.io',
    auth: { token, sessionCode },
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
  };
  if (typeof window !== 'undefined') {
    console.log('[socket] connecting to', target ?? '(same-origin)');
  }
  const s: OLPSocket = target ? io(target, opts) : io(opts);
  return s;
}
