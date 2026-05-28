import { initials } from '@/lib/format';

const COLORS = ['#4f46e5', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const bg = COLORS[(name.charCodeAt(0) + (name.charCodeAt(1) || 0)) % COLORS.length];
  return (
    <div
      className="inline-flex items-center justify-center rounded-full text-white font-bold border border-ink flex-shrink-0"
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </div>
  );
}
