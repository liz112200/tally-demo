import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';
import { SiteHeader } from '@/app/_components/site-header';
import { DemoBanner } from '@/app/_components/demo-banner';
import { DemoOrientationStrip } from '@/app/_components/demo-orientation-server';
import { DEMO_SOURCE_URL, isDemoMode } from '@/lib/demo-mode';
import { dismissedByCookie, ORIENTATION_COOKIE } from '@/lib/demo/orientation';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Tally',
  description: 'Personal expense tracking and splitting.',
};

// Applies the stored (or system) theme before first paint so neither theme
// flashes. Runs inline in <head>; localStorage may be unavailable in some
// contexts, hence the try/catch.
const themeInit = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The demo's first-visit strip, dismissed or not, known before the first
  // render (lib/demo/orientation.ts). Production never reads the cookie.
  const orientationDismissed = isDemoMode() && dismissedByCookie((await cookies()).get(ORIENTATION_COOKIE)?.value);
  return (
    <html
      lang="en"
      className={cn('font-sans', geist.variable, geistMono.variable)}
      data-demo={isDemoMode() ? '1' : undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      {/* Browser extensions (Grammarly) add attributes to <body> before
          hydration; suppress the resulting mismatch warning, as on <html>. */}
      <body className="min-h-dvh" suppressHydrationWarning>
        {isDemoMode() && <DemoBanner sourceUrl={DEMO_SOURCE_URL} orientationDismissed={orientationDismissed} />}
        <SiteHeader demo={isDemoMode()} />
        {isDemoMode() && <DemoOrientationStrip dismissed={orientationDismissed} />}
        {children}
      </body>
    </html>
  );
}
