import './globals.css';
import type { Metadata, Viewport } from 'next';
const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
/** One identity on every host (monadefi.com, mona.grok.me, the GitHub Pages URL): canonical and Open Graph always point at monadefi.com. */
const CANONICAL = 'https://monadefi.com/';
const TITLE = 'MonaDefi · Your balance. Your rules. Put it to work.';
const DESCRIPTION = 'Add supported funds, deploy into selected vaults, and manage partial or full withdrawals from one simple dashboard. Stay in control with clear rules, visible fees, and transparent withdrawal conditions. Built on PolicyPilot for Monad.';
export const metadata: Metadata = {
  metadataBase: new URL('https://monadefi.com'),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'MonaDefi',
  keywords: ['MonaDefi', 'Monad', 'vault investing', 'liquid staking', 'aprMON', 'PolicyPilot', 'MON'],
  alternates: { canonical: CANONICAL },
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, url: CANONICAL, siteName: 'MonaDefi', type: 'website', locale: 'en_GB', images: [{ url: `https://blockchains.github.io${BP || '/policypilot-monad'}/icon-512.png`, width: 512, height: 512, alt: 'MonaDefi' }] },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  manifest: `${BP}/manifest.webmanifest`,
  icons: { icon: `${BP}/favicon.png`, apple: `${BP}/apple-touch-icon.png` },
  appleWebApp: { capable: true, title: 'MonaDefi', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#09090b', colorScheme: 'dark' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="min-h-dvh bg-ink bg-[radial-gradient(ellipse_at_top,rgba(131,110,249,0.16),transparent_60%)] text-zinc-200 antialiased [-webkit-tap-highlight-color:transparent]">{children}</body></html>;
}
