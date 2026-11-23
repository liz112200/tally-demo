import { billHref } from '../../../lib/share-summary';
import { guestCopy } from '../../../lib/bill-design';
import type { BillSnapshot, PreviousBalance, ShareSnapshotLine } from '../../../lib/bill-snapshot';
import { formatPayableUSD as formatUSD, toCents } from '../../../lib/money';

function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${m}/${d}` : date;
}

function ReceiptDate({ date }: { date: string }) {
  return <time dateTime={date} title={date} aria-label={date} className="w-11 shrink-0 font-mono text-xs text-muted-foreground">{monthDay(date)}</time>;
}

function LineRow({ line }: { line: ShareSnapshotLine }) {
  return (
    <li className="flex items-baseline gap-3 border-t py-2 text-sm first:border-t-0">
      <ReceiptDate date={line.date} />
      <span className="min-w-0 flex-1 break-words">{line.description}
        {line.pickedPayment !== undefined && <small className="block text-xs text-muted-foreground">{formatUSD(toCents(line.pickedPayment))} paid toward this item</small>}
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

const money = (n: number) => formatUSD(toCents(n));
const sum = (lines: ShareSnapshotLine[]) => lines.reduce((total, line) => total + line.outstandingCents, 0);

function PreviousBillBalance({ group, billBase }: { group: PreviousBalance; billBase: string | null }) {
  const { previous, payments, adjustments, omitted, included, assigned } = group;
  const dated = group.paymentDetails ?? [];
  const undated = payments - dated.reduce((total, entry) => total + entry.amount, 0);
  const paymentLabel = group.side === 'owed' ? 'Payment from you' : 'Payment from me';

  return <section className="mb-4">
    <dl className="text-sm">
      <div className="flex items-baseline justify-between gap-3 py-2">
        <dt className="flex min-w-0 items-baseline gap-3">
          <ReceiptDate date={group.date} />
          <span>{group.partialSource ? 'Earlier entries' : 'Previous balance'}
            {group.token && billBase !== null && <a className="mt-0.5 block text-xs text-muted-foreground underline underline-offset-2" href={billHref(billBase, group.token)} rel="noreferrer">View previous bill</a>}
          </span>
        </dt>
        <dd className="shrink-0 font-mono">{money(previous)}</dd>
      </div>
      {dated.map((payment, i) => <div key={i} className="flex items-baseline justify-between gap-3 border-t py-2">
        <dt className="flex items-baseline gap-3"><ReceiptDate date={payment.date} />{paymentLabel}</dt>
        <dd className="shrink-0 font-mono">{money(-payment.amount)}</dd>
      </div>)}
      {undated !== 0 && <div className="flex items-baseline justify-between gap-3 border-t py-2 pl-14">
        <dt>{undated < 0 ? 'Payment reversed' : paymentLabel}<small className="block text-xs text-muted-foreground">Date unavailable</small></dt>
        <dd className="shrink-0 font-mono">{money(-undated)}</dd>
      </div>}
      {adjustments !== 0 && <div className="flex justify-between gap-3 border-t py-2 pl-14"><dt>Balance adjustments</dt><dd className="font-mono">{money(adjustments)}</dd></div>}
      {omitted > 0 && <div className="flex justify-between gap-3 border-t py-2 pl-14"><dt>Left off this bill</dt><dd className="font-mono">{money(-omitted)}</dd></div>}
      <div className="flex justify-between gap-3 border-t pt-2 font-medium"><dt>Carried forward {group.side === 'owed' ? 'to me' : 'to you'}</dt><dd className="font-mono">{money(included)}</dd></div>
    </dl>
    {assigned.length > 0 && <div className="mt-3 text-sm">
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">Item-specific payments</h4>
      <ul className="divide-y">{assigned.map((a, i) => <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1">
        <span>{a.description} <small className="text-muted-foreground">{monthDay(a.date)}</small></span>
        <span>{money(a.paid)} paid{a.remaining !== undefined && (a.remaining > 0 ? ' · ' + money(a.remaining) + ' left' : ' · paid in full')}</span>
      </li>)}</ul>
    </div>}
  </section>;
}

export function SharedBill({ snapshot, billBase, note, embedded = false }: { snapshot: BillSnapshot; billBase: string | null; note?: string; embedded?: boolean }) {
  const { personName, owed, owing, owedCents, owingCents, netCents } = snapshot;
  const balances = snapshot.previousBalances ?? [];
  const hasPrevious = balances.length > 0;
  const newOwed = hasPrevious ? owed.filter(line => !line.carried) : owed;
  const newOwing = hasPrevious ? owing.filter(line => !line.carried) : owing;
  const itemCount = newOwed.length + newOwing.length;
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
          {hasPrevious ? 'Shared ' : `${itemCount} open item${itemCount === 1 ? '' : 's'} · shared `}
          {snapshot.createdAt.toISOString().slice(0, 10)}
        </p>
      </header>

      {/* The net leads, because it is the number the reader can act on. */}
      <div className="mb-5 rounded-xl border bg-card px-4 py-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          Total: <strong className="font-mono text-3xl">{formatUSD(toCents(Math.abs(netCents)))}</strong>
          <span className="text-muted-foreground">{guestCopy.balance(netCents)}</span>
        </p>
        {!hasPrevious && [...owed,...owing].some(line => line.carried) && <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          {[true, false].map(carried => {
            const sum = (lines: ShareSnapshotLine[]) => lines.filter(l => Boolean(l.carried) === carried).reduce((s,l) => s + l.outstandingCents, 0);
            const amount = sum(owed) - sum(owing);
            return [...owed,...owing].some(l => Boolean(l.carried) === carried) && <p key={String(carried)} className="flex justify-between gap-2"><span>{carried ? 'From earlier bills' : 'Current items'}</span><span>{formatUSD(toCents(Math.abs(amount)))} {guestCopy.balance(amount)}</span></p>;
          })}
        </div>}
      </div>

      {hasPrevious && itemCount > 0 && <h2 className="mb-3 font-medium">New entries</h2>}
      <Section
        title={guestCopy.coveredByMe}
        totalCents={hasPrevious ? sum(newOwed) : owedCents}
        lines={newOwed}
        grouped={snapshot.groupedByCategory}
      />
      <Section
        title={guestCopy.coveredByYou}
        totalCents={hasPrevious ? sum(newOwing) : owingCents}
        lines={newOwing}
        grouped={snapshot.groupedByCategory}
      />

      {hasPrevious && <div className="previous-bills mt-5 pt-4">
        <h2 className="mb-3 font-medium">From earlier bills</h2>
        {balances.map((group, index) => <PreviousBillBalance key={index} group={group} billBase={billBase} />)}
      </div>}
      <p className="mt-5 text-xs text-muted-foreground">
        {note ?? 'Amounts are from the day this bill was shared.'}
      </p>
    </Container>
  );
}
