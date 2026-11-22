import { guestCopy } from '../../../lib/bill-design';
import type { BillSnapshot, ShareSnapshotLine } from '../../../lib/bill-snapshot';
import { formatPayableUSD as formatUSD, toCents } from '../../../lib/money';

function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${m}/${d}` : date;
}

function LineRow({ line }: { line: ShareSnapshotLine }) {
  return (
    <li className="flex items-baseline gap-3 border-t py-2 text-sm first:border-t-0">
      <span className="w-11 shrink-0 font-mono text-xs text-muted-foreground">
        {monthDay(line.date)}
      </span>
      <span className="min-w-0 flex-1 break-words">{line.description}
        {line.carried && <small className="block text-xs text-muted-foreground">
          From {monthDay(line.carried.date)} · {formatUSD(toCents(line.carried.previous))} previously
          {line.carried.cash > 0 && <> · {formatUSD(toCents(line.carried.cash))} paid since</>}
          {(line.carried.adjustment !== 0 || line.carried.cash < 0) && <> · balance adjusted</>}
        </small>}
      </span>
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
  lines: ShareSnapshotLine[];
  grouped: boolean;
}) {
  if (lines.length === 0) return null;

  const order: string[] = [];
  const byCategory = new Map<string, ShareSnapshotLine[]>();
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

export function SharedBill({ snapshot, note, embedded = false }: { snapshot: BillSnapshot; note?: string; embedded?: boolean }) {
  const { personName, owed, owing, owedCents, owingCents, netCents } = snapshot;
  const itemCount = owed.length + owing.length;
  const Container = embedded ? 'article' : 'main';
  const Title = embedded ? 'h3' : 'h1';

  return (
    <Container data-paper={snapshot.paper} className="shared-check bill-paper">
      <header className="mb-5">
        <span className="guest-stamp">Shared bill</span>
        <Title className="text-lg font-semibold tracking-tight">
          {guestCopy.heading(personName)}
        </Title>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {itemCount} open item{itemCount === 1 ? '' : 's'} · shared{' '}
          {snapshot.createdAt.toISOString().slice(0, 10)}
        </p>
      </header>

      {/* The net leads, because it is the number the reader can act on. */}
      <div className="mb-5 rounded-xl border bg-card px-4 py-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          Total: <strong className="font-mono text-3xl">{formatUSD(toCents(Math.abs(netCents)))}</strong>
          <span className="text-muted-foreground">{guestCopy.balance(netCents)}</span>
        </p>
        {[...owed,...owing].some(line => line.carried) && <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          {[true, false].map(carried => {
            const sum = (lines: ShareSnapshotLine[]) => lines.filter(l => Boolean(l.carried) === carried).reduce((s,l) => s + l.outstandingCents, 0);
            const amount = sum(owed) - sum(owing);
            return [...owed,...owing].some(l => Boolean(l.carried) === carried) && <p key={String(carried)} className="flex justify-between gap-2"><span>{carried ? 'From earlier bills' : 'Current items'}</span><span>{formatUSD(toCents(Math.abs(amount)))} {guestCopy.balance(amount)}</span></p>;
          })}
        </div>}
      </div>

      <Section
        title={guestCopy.coveredByMe}
        totalCents={owedCents}
        lines={owed}
        grouped={snapshot.groupedByCategory}
      />
      <Section
        title={guestCopy.coveredByYou}
        totalCents={owingCents}
        lines={owing}
        grouped={snapshot.groupedByCategory}
      />

      <p className="mt-5 text-xs text-muted-foreground">
        {note ?? 'Amounts are from the day this bill was shared.'}
      </p>
    </Container>
  );
}
