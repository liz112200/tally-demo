'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FlaskConical, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resetDemoNow } from '@/app/_actions/demo';
import { setOrientationDismissed } from '@/lib/demo/orientation';
import { useOrientationDismissed } from '@/app/_lib/use-orientation';

// Shown only on the public demo deployment (the layout gates it on
// DEMO_MODE). Says what this is, how long changes last, and where the source
// lives, and lets anyone put the data back the way it started.
export function DemoBanner({ sourceUrl, orientationDismissed: fromServer }: { sourceUrl: string; orientationDismissed: boolean }) {
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const orientationDismissed = useOrientationDismissed(fromServer);
  // Share snapshots are read by someone outside the app; no chrome there.
  if (pathname.startsWith('/s/')) return null;

  function reset() {
    setMessage(null);
    startTransition(async () => {
      const result = await resetDemoNow();
      setMessage('error' in result ? result.error : 'Demo data restored.');
      // A fresh start includes the tour.
      if (!('error' in result)) setOrientationDismissed(false);
    });
  }

  return (
    <div className="border-b bg-primary/10 text-[13px]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 px-6 py-2">
        <FlaskConical className="size-4 shrink-0 text-primary" aria-hidden />
        <p>
          <strong className="font-medium">This is a demo.</strong>{' '}
          Every person, merchant, and amount is synthetic. Data resets daily.{' '}
          <Link
            href={sourceUrl}
            className="underline underline-offset-2 hover:text-primary"
            target="_blank"
            rel="noreferrer"
          >
            See source
          </Link>
        </p>
        <div className="ml-auto flex items-center gap-2">
          {orientationDismissed && (
            <Button variant="ghost" size="xs" onClick={() => setOrientationDismissed(false)}>
              Things to try
            </Button>
          )}
          {message && (
            <span className="text-xs text-muted-foreground" role="status">
              {message}
            </span>
          )}
          <Button variant="outline" size="xs" onClick={reset} disabled={pending}>
            <RotateCcw aria-hidden />
            {pending ? 'Resetting…' : 'Reset demo'}
          </Button>
        </div>
      </div>
    </div>
  );
}
