import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Voice Capture — AiRK',
  description: 'Capture requests. Keep the judgment. Confirm every booking.',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Voice Capture' }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
