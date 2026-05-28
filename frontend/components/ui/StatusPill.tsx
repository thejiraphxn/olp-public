type Kind =
  | 'draft'
  | 'scheduled'
  | 'pending'
  | 'recording'
  | 'processing'
  | 'ready'
  | 'failed';

const MAP: Record<Kind, { bg: string; fg: string; border: string; label: string; blink?: boolean }> = {
  draft: { bg: 'bg-paper-alt', fg: 'text-ink-soft', border: 'border-ink-mute/40', label: 'draft' },
  scheduled: { bg: 'bg-accent-soft', fg: 'text-accent', border: 'border-accent', label: 'scheduled' },
  pending: { bg: 'bg-paper-alt', fg: 'text-ink-soft', border: 'border-ink-mute/40', label: 'pending' },
  recording: { bg: 'bg-live-soft', fg: 'text-live', border: 'border-live', label: '● LIVE', blink: true },
  processing: { bg: 'bg-warn-soft', fg: 'text-warn', border: 'border-warn', label: 'processing…' },
  ready: { bg: 'bg-ok-soft', fg: 'text-ok', border: 'border-ok', label: 'ready' },
  failed: { bg: 'bg-red-100', fg: 'text-red-800', border: 'border-red-800', label: 'failed' },
};

export function StatusPill({
  kind,
  small,
  className = '',
}: {
  kind: Kind | (string & {});
  small?: boolean;
  className?: string;
}) {
  const norm = (kind || '').toLowerCase() as Kind;
  const c = MAP[norm] ?? MAP.draft;
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full font-bold border whitespace-nowrap',
        small ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs',
        c.bg,
        c.fg,
        c.border,
        c.blink ? 'animate-blink' : '',
        className,
      ].join(' ')}
    >
      {c.label}
    </span>
  );
}

import { RecordingStatus, SessionStatus } from '@/lib/enums';

export function sessionStatusPillKind(
  sessionStatus: string,
  recordingStatus?: string | null,
): Kind {
  if (recordingStatus === RecordingStatus.READY) return 'ready';
  if (recordingStatus === RecordingStatus.PROCESSING) return 'processing';
  if (recordingStatus === RecordingStatus.FAILED) return 'failed';
  if (sessionStatus === SessionStatus.LIVE) return 'recording';
  if (sessionStatus === SessionStatus.SCHEDULED) return 'scheduled';
  if (sessionStatus === SessionStatus.ENDED) return 'pending';
  return 'draft';
}
