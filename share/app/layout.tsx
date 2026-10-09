import type { Metadata } from 'next';
import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

// No navigation and no wordmark linking anywhere: a reader here is not the
// ledger's owner and has nothing else to reach.
export const metadata: Metadata = {
  title: 'Shared list',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body
        className="min-h-dvh"
        style={{ fontFamily: 'var(--font-sans), system-ui, sans-serif' }}
      >
        {children}
      </body>
    </html>
  );
}
