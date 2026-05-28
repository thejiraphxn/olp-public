export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={[
        'bg-paper-alt border border-ink/10 rounded animate-pulse',
        className,
      ].join(' ')}
    />
  );
}
