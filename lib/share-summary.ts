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
}: ShareSummaryInput): string {
  if (owed.length === 0 && owing.length === 0) return '';

  const owedTotal = sumLines(owed);
  const owingTotal = sumLines(owing);
  const net = owedTotal - owingTotal;

  const out: string[] = [`Hi ${personName} — here's where we're at:`, ''];

  const count = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  if (owed.length > 0) {
    out.push(
      `What you owe me (${count(owed.length)}) — ${formatUSD(toCents(owedTotal))}`,
    );
    out.push(...renderSection(owed, groupBy, limit));
    out.push('');
  }
  if (owing.length > 0) {
    out.push(
      `What I owe you (${count(owing.length)}) — ${formatUSD(toCents(owingTotal))}`,
    );
    out.push(...renderSection(owing, groupBy, limit));
    out.push('');
  }

  // The net is the point of the message, so it is stated in words rather
  // than left for the reader to subtract.
  if (net > 0) {
    out.push(`Net: you owe me ${formatUSD(toCents(net))}`);
  } else if (net < 0) {
    out.push(`Net: I owe you ${formatUSD(toCents(-net))}`);
  } else {
    out.push('Net: we’re settled up');
  }

  // Only worth linking when the message actually withheld something.
  const withheld =
    limit !== undefined && (limit < owed.length || limit < owing.length);
  if (linkUrl && withheld) {
    out.push('', `Full list: ${linkUrl}`);
  }

  return out.join('\n');
}

// Absolute URL for a published snapshot.
//
// The base comes from NEXT_PUBLIC_SHARE_BASE_URL, which is pasted by hand
// from the Vercel dashboard — and the dashboard displays domains without a
// scheme ("share-snowy-seven.vercel.app"). A scheme-less string still forms a
// plausible-looking URL, but messaging apps will not reliably turn it into a
// tappable link, leaving the recipient to copy it into a browser by hand. So
// the scheme is normalized here rather than assumed of the environment.
export function absoluteShareUrl(base: string, token: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  // An explicit scheme is preserved, so http://localhost keeps working in
  // development; anything else is assumed to be a bare host.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return `${withScheme}/s/${token}`;
}
