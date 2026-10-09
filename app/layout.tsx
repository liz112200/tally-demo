import type { Metadata } from 'next';
import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';
import { SiteHeader } from '@/app/_components/site-header';
import { DemoBanner } from '@/app/_components/demo-banner';
import { DemoOrientation } from '@/app/_components/demo-orientation';
import { DEMO_SOURCE_URL, isDemoMode } from '@/lib/demo-mode';

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      <body className="min-h-dvh">
        {isDemoMode() && <DemoBanner sourceUrl={DEMO_SOURCE_URL} />}
        <SiteHeader />
        {isDemoMode() && <DemoOrientation />}
        {children}
      </body>
    </html>
  );
}
