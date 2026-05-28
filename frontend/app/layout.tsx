import './globals.css';
import 'sweetalert2/dist/sweetalert2.min.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Online Learning Platform',
  description: 'Session-based teaching with screen+audio recording and playback',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
