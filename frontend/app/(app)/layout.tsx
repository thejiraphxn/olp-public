import { ShellProvider } from '@/components/shell/ShellProvider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ShellProvider>{children}</ShellProvider>;
}
