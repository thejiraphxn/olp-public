/**
 * Single-origin deploy model.
 *
 * The browser never talks to the backend directly — all API + Socket.IO
 * traffic is proxied through the Next.js server. That means:
 *   - cookies are always first-party (no SameSite=None gymnastics)
 *   - CORS is only ever a concern for direct-backend debugging in dev
 *   - deploying behind a single domain "just works"
 *
 * `BACKEND_URL` is a server-only env var read at request time by the Next
 * server. It defaults to localhost:4000 for local dev.
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict Mode double-invokes effects in dev, which makes getDisplayMedia
  // open the screen picker twice when the Recorder mounts with autoStart.
  // Disable globally — we don't rely on Strict Mode checks elsewhere and
  // this only affects the dev build.
  reactStrictMode: false,
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` },
      // Socket.IO long-polling + WebSocket upgrade (self-hosted Next 14+ proxies Upgrade)
      { source: '/socket.io/:path*', destination: `${BACKEND_URL}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
