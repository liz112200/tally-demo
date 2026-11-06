// "synced 5h ago" rather than a timestamp, with the exact time kept for a
// hover. Pure: the caller passes now, and the page computes it in the
// browser and updates it, so a tab left open never shows a frozen "5h ago"
// (2026-11-04: an overnight tab read as a sync that never ran).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(then: Date, now: Date): string {
  const ago = now.getTime() - then.getTime();
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  if (ago < 2 * DAY) return 'yesterday';
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(then.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

// "Nov 4, 2026, 10:36 UTC": the exact time behind a relative one.
export function exactTime(then: Date): string {
  return `${then.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`;
}
