// Plain-text summary of where two people stand, for sharing over SMS or a
// messaging app. Pure and framework-free like the rest of lib/: the People
// UI hands it rows already in display order and renders nothing itself.
//
// The summary covers BOTH directions and nets them. A message listing only
// what someone owes, while quietly omitting what they are owed back,
// overstates the debt — the figure the recipient can act on is the net.
//
// The output is deliberately plain — no markdown, no column alignment. SMS
// and messenger clients reflow text in proportional fonts, so padded columns
// arrive ragged; one item per line survives everywhere.
import { guestCopy } from './bill-design';
import { formatPayableUSD as formatUSD, toCents } from './money';

export type ShareLine = {
  date: string;
  description: string;
  // What is still owed on this share, not its original amount: a partly
  // settled share should be shared at its remaining balance.
  outstandingCents: number;
  category: string | null;
};

// "YYYY-MM-DD" -> "MM/DD". The year is dropped: these lists are recent by
// nature, and the line is read on a phone.
function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${m}/${d}` : date;
}

const UNCATEGORIZED = 'Uncategorized';

export function sumLines(lines: readonly ShareLine[]): number {
  return lines.reduce((acc, l) => acc + l.outstandingCents, 0);
}

export type ShareSummaryInput = {
  personName: string;
  // What this person owes the owner, in display order.
  owed: readonly ShareLine[];
  // What the owner owes this person, in display order.
  owing: readonly ShareLine[];
  // 'category' inserts a heading per category within each section.
  groupBy?: 'category' | null;
  // Render at most this many lines per section, replacing the rest with a
  // count. Omitted renders every line.
  limit?: number;
  // Where the full snapshot lives. Appended once, at the end.
  linkUrl?: string;
  guestCheck?: boolean;
};

function renderSection(
  lines: readonly ShareLine[],
  groupBy: 'category' | null,
  limit: number | undefined,
): string[] {
  const item = (l: ShareLine) =>
    `  ${monthDay(l.date)}  ${l.description} — ${formatUSD(toCents(l.outstandingCents))}`;

  const truncated = limit !== undefined && limit < lines.length;
  const shown = truncated ? lines.slice(0, limit) : lines;
  const out: string[] = [];

  // A truncated list is rendered flat even under a category sort: headings
  // over an arbitrary prefix would imply those categories are complete. The
  // linked page keeps the grouping.
  if (groupBy === 'category' && !truncated) {
    const seen: string[] = [];
    const byCategory = new Map<string, ShareLine[]>();
    for (const l of shown) {
      const key = l.category ?? UNCATEGORIZED;
      if (!byCategory.has(key)) {
        byCategory.set(key, []);
        seen.push(key);
      }
      byCategory.get(key)!.push(l);
    }
    for (const key of seen) {
      const group = byCategory.get(key)!;
      out.push(`  ${key} (${formatUSD(toCents(sumLines(group)))})`);
      out.push(...group.map((l) => `  ${item(l)}`));
    }
  } else {
    out.push(...shown.map(item));
    if (truncated) out.push(`  …and ${lines.length - shown.length} more`);
  }
  return out;
}

// Renders the whole message. Returns an empty string when neither side has
// anything outstanding, so callers can disable the share affordance.
export function buildShareSummary({
  personName,
  owed,
  owing,
  groupBy = null,
  limit,
  linkUrl,
  guestCheck = false,
}: ShareSummaryInput): string {
  if (owed.length === 0 && owing.length === 0) return '';

  const owedTotal = sumLines(owed);
  const owingTotal = sumLines(owing);
  const net = owedTotal - owingTotal;

  const out: string[] = guestCheck
    ? [`Total: ${guestCheckBalance(net)} · ${guestCopy.balance(net)}`, '']
    : [`Hi ${personName} — here's where we're at:`, ''];

  const count = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  if (owed.length > 0) {
    out.push(
      `${guestCheck ? guestCopy.coveredByMe : 'What you owe me'} (${count(owed.length)}) — ${formatUSD(toCents(owedTotal))}`,
    );
    out.push(...renderSection(owed, groupBy, limit));
    out.push('');
  }
  if (owing.length > 0) {
    out.push(
      `${guestCheck ? guestCopy.coveredByYou : 'What I owe you'} (${count(owing.length)}) — ${formatUSD(toCents(owingTotal))}`,
    );
    out.push(...renderSection(owing, groupBy, limit));
    out.push('');
  }

  // The net is the point of the message, so it is stated in words rather
  // than left for the reader to subtract.
  if (!guestCheck) {
    if (net > 0) out.push(`Net: you owe me ${formatUSD(toCents(net))}`);
    else if (net < 0) out.push(`Net: I owe you ${formatUSD(toCents(-net))}`);
    else out.push('Net: we’re settled up');
  } else {
    out.pop(); // The last item group already added a blank line.
  }

  // A decorated guest check also needs its link when all items fit inline.
  const withheld =
    limit !== undefined && (limit < owed.length || limit < owing.length);
  if (linkUrl && (withheld || guestCheck)) {
    out.push('', guestCheck ? `Bill: ${linkUrl}` : `Full list: ${linkUrl}`);
  }

  return out.join('\n');
}

export function guestCheckBalance(net: number): string {
  return formatUSD(toCents(Math.abs(net)));
}

// Vercel may supply a bare domain. Only accept a viewer origin, never a
// private app hostname (including its production alias) or a path or query.
export function billViewerOrigin(
  configured: string | undefined,
  appHosts: (string | null | undefined)[],
  development = false,
): string | null {
  const base = configured?.trim();
  if (!base) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`);
    if (url.protocol !== 'https:' && !(development && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname.replace(/\//g, '') || url.search || url.hash) return null;
    const matchesApp = appHosts.some(host => {
      if (!host) return false;
      const app = new URL(`https://${host}`);
      return development ? app.host === url.host :
        app.hostname.replace(/\.$/, '') === url.hostname.replace(/\.$/, '');
    });
    return matchesApp ? null : url.origin;
  } catch {
    return null;
  }
}

// An empty base is the explicitly same-site demo or local viewer.
export function billHref(base: string, token: string): string {
  return `${base}/s/${encodeURIComponent(token)}`;
}
