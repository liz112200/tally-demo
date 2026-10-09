import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSnapshot, type SnapshotLine } from '@/db';
// Imported from the app's lib rather than copied: the money scale has
// already widened once, and a duplicate formatter would drift silently.
import { formatUSD, toCents } from '@shared/money';

// A share snapshot is a fixed document, but it is looked up by a token that
// only exists once one is published, so it cannot be prerendered.
export const dynamic = 'force-dynamic';

// Keep snapshots out of search results. They are unguessable rather than
// secret, and a crawler that somehow saw a link should not index it.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${m}/${d}` : date;
}

function LineRow({ line }: { line: SnapshotLine }) {
  return (
    <li className="flex items-baseline gap-3 border-t py-2 text-sm first:border-t-0">
      <span className="w-11 shrink-0 font-mono text-xs text-muted-foreground">
        {monthDay(line.date)}
      </span>
      <span className="min-w-0 flex-1 break-words">{line.description}</span>
      <span className="shrink-0 font-mono">
        {formatUSD(toCents(line.outstandingCents))}
      </span>
    </li>
  );
}

// One direction's lines, grouped by category when the snapshot was shared
// that way. Groups follow the stored order, which is the order the sender
// was looking at — the page is a snapshot, not a re-render.
function Section({
  title,
  totalCents,
  lines,
  grouped,
}: {
  title: string;
  totalCents: number;
  lines: SnapshotLine[];
  grouped: boolean;
}) {
  if (lines.length === 0) return null;

  const order: string[] = [];
  const byCategory = new Map<string, SnapshotLine[]>();
  if (grouped) {
    for (const l of lines) {
      const key = l.category ?? 'Uncategorized';
      if (!byCategory.has(key)) {
        byCategory.set(key, []);
        order.push(key);
      }
      byCategory.get(key)!.push(l);
    }
  }

  return (
    <section className="mb-4">
      <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <span className="font-mono text-sm">{formatUSD(toCents(totalCents))}</span>
      </div>
      <div className="rounded-xl border bg-card px-4 py-1">
        {grouped ? (
          order.map((key) => {
            const group = byCategory.get(key)!;
            const subtotal = group.reduce((a, l) => a + l.outstandingCents, 0);
            return (
              <div key={key} className="border-t py-2 first:border-t-0">
                <div className="flex items-baseline justify-between gap-2 pb-1 text-[11px] text-muted-foreground">
                  <span className="font-medium uppercase tracking-wider">{key}</span>
                  <span className="font-mono">{formatUSD(toCents(subtotal))}</span>
                </div>
                <ul>
                  {group.map((l, i) => (
                    <LineRow key={`${l.date}-${i}`} line={l} />
                  ))}
                </ul>
              </div>
            );
          })
        ) : (
          <ul>
            {lines.map((l, i) => (
              <LineRow key={`${l.date}-${i}`} line={l} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default async function SharedListPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getSnapshot(token);
  if (!snapshot) notFound();

  const { personName, owed, owing, owedCents, owingCents, netCents } = snapshot;
  const itemCount = owed.length + owing.length;

  return (
    <main className="mx-auto max-w-lg px-5 py-10">
      <header className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">
          Where we&rsquo;re at, {personName}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {itemCount} item{itemCount === 1 ? '' : 's'} · shared{' '}
          {snapshot.createdAt.toISOString().slice(0, 10)}
        </p>
      </header>

      {/* The net leads, because it is the number the reader can act on. */}
      <div className="mb-5 rounded-xl border bg-card px-4 py-3">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {netCents > 0
            ? 'You owe'
            : netCents < 0
              ? 'You are owed'
              : 'Settled up'}
        </p>
        <p className="font-mono text-3xl">
          {formatUSD(toCents(Math.abs(netCents)))}
        </p>
        {owed.length > 0 && owing.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUSD(toCents(owedCents))} owed less{' '}
            {formatUSD(toCents(owingCents))} owed back
          </p>
        )}
      </div>

      <Section
        title="What you owe"
        totalCents={owedCents}
        lines={owed}
        grouped={snapshot.groupedByCategory}
      />
      <Section
        title="What you're owed back"
        totalCents={owingCents}
        lines={owing}
        grouped={snapshot.groupedByCategory}
      />

      <p className="mt-5 text-xs text-muted-foreground">
        A snapshot of the list as it was shared. It does not update as
        payments are made.
      </p>
    </main>
  );
}
