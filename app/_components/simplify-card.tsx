'use client';

import { useState } from 'react';
import { ArrowRight, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUSD } from '@/lib/money';
import type { SimplifyView } from '@/lib/simplify-view';

type Payment = SimplifyView['transfers'][number];

// "Simplify balances" on /people: how many debts are open, what settling up
// person by person takes, and the shorter set of transfers that would clear
// the whole group. A suggestion only — nothing is recorded from here.
export function SimplifyCard({
  view,
  names,
  ownerId,
}: {
  view: SimplifyView;
  // Display name per person id; the owner renders as "You".
  names: Record<string, string>;
  ownerId: string;
}) {
  const [open, setOpen] = useState(false);
  const { outstandingDebts, peopleInvolved, perPersonPayments, transfers } = view;
  const name = (id: string) => (id === ownerId ? 'You' : (names[id] ?? 'Unknown'));

  return (
    <section className="mb-4 rounded-xl border bg-card px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Shuffle className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="font-medium">Simplify balances</h2>
        <p className="text-muted-foreground">
          <Count n={outstandingDebts} one="outstanding debt" many="outstanding debts" />{' '}
          between {peopleInvolved} people
          <Step />
          <Count n={perPersonPayments.length} one="per-person payment" many="per-person payments" />
          <Step />
          <Count n={transfers.length} one="transfer" many="transfers" />
        </p>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide transfers' : 'Show transfers'}
        </Button>
      </div>

      {open && (
        <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Suggested payments. You can record payments you send or receive.
          </p>
          <PaymentList title="Settling person by person" payments={perPersonPayments} name={name} />
          <PaymentList title="Simplified" payments={transfers} name={name} highlight />
        </div>
      )}
    </section>
  );
}

function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span>
      <span className="font-mono text-foreground">{n}</span> {n === 1 ? one : many}
    </span>
  );
}

function Step() {
  return <ArrowRight className="mx-1.5 inline size-3 align-[-1px]" aria-label="becomes" />;
}

function PaymentList({
  title,
  payments,
  name,
  highlight,
}: {
  title: string;
  payments: Payment[];
  name: (id: string) => string;
  highlight?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {payments.length}
      </h3>
      {payments.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing to pay.</p>
      ) : (
        <ul className="space-y-1">
          {payments.map((p, i) => (
            <li
              key={i}
              className={
                highlight
                  ? 'flex items-center gap-2 rounded-md bg-primary/5 px-2 py-1'
                  : 'flex items-center gap-2 rounded-md px-2 py-1'
              }
            >
              <span>{name(p.fromPersonId)}</span>
              <ArrowRight className="size-3 text-muted-foreground" aria-label="pays" />
              <span>{name(p.toPersonId)}</span>
              <span className="ml-auto font-mono">{formatUSD(p.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
