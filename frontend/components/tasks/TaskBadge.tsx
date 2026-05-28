import { TASK_BADGE_KIND, TASK_LABELS, type TaskStatus } from '@/lib/taskStatus';

const KIND_CLASS: Record<string, string> = {
  queued: 'bg-paper-alt text-ink-soft border-ink/30',
  working: 'bg-warn-soft text-warn border-warn',
  busy: 'bg-accent-soft text-accent border-accent',
  ready: 'bg-ok-soft text-ok border-ok',
  failed: 'bg-live-soft text-live border-live',
  canceled: 'bg-paper-alt text-ink-mute border-ink/20',
};

export function TaskBadge({
  status,
  attempts,
  errorMessage,
  className = '',
}: {
  status: TaskStatus;
  attempts?: number;
  errorMessage?: string | null;
  className?: string;
}) {
  const kind = TASK_BADGE_KIND[status];
  const label = TASK_LABELS[status];
  const isWorking = kind === 'working' || kind === 'busy';
  return (
    <span
      title={errorMessage ?? undefined}
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold',
        KIND_CLASS[kind] ?? KIND_CLASS.queued,
        className,
      ].join(' ')}
    >
      {isWorking && (
        <span
          className="w-2 h-2 rounded-full border-2 border-current border-t-transparent animate-spin"
          aria-hidden
        />
      )}
      <span>{label}</span>
      {typeof attempts === 'number' && attempts > 1 && (
        <span className="opacity-70">· retry {attempts}</span>
      )}
    </span>
  );
}
