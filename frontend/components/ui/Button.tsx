import React from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'soft' | 'live';
type Size = 'sm' | 'md' | 'lg';

const V: Record<Variant, string> = {
  primary: 'bg-accent text-white border-accent hover:brightness-110',
  ghost: 'bg-transparent text-ink border-ink hover:bg-paper-alt',
  danger: 'bg-live text-white border-live hover:brightness-110',
  soft: 'bg-accent-soft text-accent border-accent',
  live: 'bg-live-soft text-live border-live',
};

const S: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  variant = 'ghost',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...rest}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded border font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        V[variant],
        S[size],
        className,
      ].join(' ')}
    />
  );
}
