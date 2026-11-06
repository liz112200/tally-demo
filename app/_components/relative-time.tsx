'use client';

import { useEffect, useState } from 'react';
import { exactTime, relativeTime } from '@/lib/relative-time';

// "synced 5h ago", computed in the browser and updated each minute, so a tab
// left open reads its own clock rather than the moment it was rendered
// (2026-11-04: an overnight tab read as a sync that never ran). The exact
// time is the hover.
export function RelativeTime({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  const then = new Date(iso);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    // The server's render may differ by a minute from the browser's first.
    <time dateTime={iso} title={exactTime(then)} suppressHydrationWarning>
      {prefix}
      {relativeTime(then, now)}
    </time>
  );
}
