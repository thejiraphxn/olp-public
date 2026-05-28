import { CourseRole } from '@/lib/enums';

export function RoleBadge({ role }: { role: CourseRole }) {
  const teacher = role === CourseRole.TEACHER;
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border',
        teacher
          ? 'bg-accent-soft text-accent border-accent'
          : 'bg-transparent text-ink border-ink',
      ].join(' ')}
    >
      {role}
    </span>
  );
}
