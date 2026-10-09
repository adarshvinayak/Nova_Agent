import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Nova Agent',
  description: 'Capture requests. Keep the judgment. Confirm every booking.',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Nova Agent' }
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#17253b' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><aside className="beta-disclaimer" aria-label="Beta disclaimer">Beta version, for evaluation only. Do not enter live, personal or confidential information.</aside>{children}</body></html>;
}
