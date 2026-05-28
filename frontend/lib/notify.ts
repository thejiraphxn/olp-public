'use client';

/**
 * Lightweight notification helpers — sound + browser Notification API.
 * Used to alert teachers of incoming events (raised hands, new questions).
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioCtx) return audioCtx;
  const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {}
  return audioCtx;
}

/**
 * Play a short two-note chime. Safe to call without a user gesture —
 * browsers that require one will silently no-op. By the time a teacher is
 * receiving events they've already clicked through the page so the
 * AudioContext is usually unlocked.
 */
export function playChime() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    // Two-note ascending chime: A5 → E6
    const tones: [number, number][] = [
      [880, 0],
      [1319, 0.12],
    ];
    for (const [freq, delay] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.18, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.3);
    }
  } catch {}
}

/**
 * Request permission once; cached after the first call. Returns true if
 * notifications can be shown.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

export async function showDesktopNotification(
  title: string,
  body: string,
  opts: { requireFocus?: boolean; tag?: string } = {},
) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  // Only notify when the tab is hidden/unfocused, unless requireFocus=false.
  if (opts.requireFocus !== false && !document.hidden) return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: opts.tag,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    setTimeout(() => n.close(), 6000);
  } catch {}
}
