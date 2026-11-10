'use client';

import { useState, useTransition } from 'react';
import { Plus, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { formatUSD, toCents } from '@/lib/money';
import type { TransactionRow } from '@/db/queries';
import type { ConversionPlan } from '@/db/alongside';
import { addPaidAlongside, convertToPaidAlongside, previewConversion } from '@/app/_actions/alongside';
import { recordRaisedRowReview } from '@/app/_actions/reviews';
import { useAction } from './page-result';

// Paid alongside (PAID-ALONGSIDE.md) in a transaction's detail: what was paid
// off-card next to it, adding one, and moving an amount raised after import
// into one. Every amount is shown exactly.

const usd = (n: number) => formatUSD(toCents(n));

export type AlongsideLink = { id: string; descriptionRaw: string; amountCents: number };

export function PaidAlongsideBlock({
  row,
  alongsideOf,
  alongside,
  conversion,
  kept = null,
}: {
  row: TransactionRow;
  // The charge this row was paid alongside, when it is such a purchase.
  alongsideOf: AlongsideLink | null;
  // What was paid alongside this row.
  alongside: AlongsideLink[];
  // A raised row with a split: null when the conversion would accept it
  // (Move is offered), else why not (said, with no button); undefined for
  // any other row. The same check as the band and the raised filter.
  conversion: string | null | undefined;
  // Kept raised by a review that still applies (the row still has the
  // amount it was kept at).
  kept?: { note: string; reviewedAt: string } | null;
}) {
  return (
    <div className="space-y-1 text-xs">
      {alongsideOf && (
        <p className="text-muted-foreground">
          Paid alongside {alongsideOf.descriptionRaw} ({usd(alongsideOf.amountCents)}).
        </p>
      )}
      {alongside.length > 0 && (
        <ul className="space-y-0.5">
          {alongside.map((a) => (
            <li key={a.id} className="flex justify-between gap-4">
              <span>Paid alongside: {a.descriptionRaw}</span>
              <span className="font-mono tabular-nums">{usd(a.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {conversion === null && kept && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Kept raised {kept.reviewedAt.slice(0, 10)}:</span> {kept.note} Move is still here if
          you change your mind; a change to its amount raises it again.
        </p>
      )}
      {typeof conversion === 'string' && (
        <p className="text-muted-foreground">Raised after it came in. Moving the extra is not offered: {conversion}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {!alongsideOf && <AddAlongsideButton row={row} />}
        {conversion === null && <ConvertButton row={row} />}
        {conversion === null && !kept && <KeepRaisedButton row={row} />}
      </div>
    </div>
  );
}

function AddAlongsideButton({ row }: { row: TransactionRow }) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [amount, setAmount] = useState('');
  const { run, pending } = useAction({ errorsInPlace: true });
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 text-xs">
            <Plus data-icon="inline-start" />
            Add what you paid alongside this
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Paid alongside {row.descriptionRaw}</DialogTitle>
          <DialogDescription>
            Something you paid off this card, such as cash for gas on the same trip. It is a purchase of yours on{' '}
            {row.date}, in this row&apos;s category, split equally with the same people. This row stays as it is.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="alongside-what">What was it?</Label>
            <Input
              id="alongside-what"
              value={what}
              onChange={(e) => {
                setWhat(e.target.value);
                setError(null);
              }}
              placeholder="Gas and tolls, cash"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="alongside-amount">Amount</Label>
            <Input
              id="alongside-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
              }}
              placeholder="0.00"
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={pending || !what.trim() || !amount.trim() || error !== null}
            onClick={() =>
              run(
                () => addPaidAlongside(row.id, what, amount),
                (r) => ('error' in r ? setError(r.error) : (setOpen(false), setWhat(''), setAmount(''), setError(null))),
              )
            }
          >
            {pending ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConvertButton({ row }: { row: TransactionRow }) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [plan, setPlan] = useState<ConversionPlan | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const { run, pending } = useAction({ errorsInPlace: true });
  const [error, setError] = useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setPlan(null);
    setRefusal(null);
    setError(null);
    startLoading(async () => {
      const preview = await previewConversion(row.id);
      if ('plan' in preview) setPlan(preview.plan);
      else setRefusal(preview.error);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 text-xs">
            <Shuffle data-icon="inline-start" />
            Move the extra into a purchase paid alongside
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move the extra out of {row.descriptionRaw}</DialogTitle>
          <DialogDescription>
            This row&apos;s amount was raised after it came in. Converting returns it to the amount it came in with and
            records the extra as a purchase you paid alongside it, split the same way. Nobody&apos;s balance or payment
            changes, and neither does your spending; if any figure below would, it is refused.
          </DialogDescription>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Working out what would change…</p>}
        {/* Offered only where the conversion accepts the row; a refusal here
            means the row changed since (another tab), and is said as one. */}
        {refusal && (
          <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            Not converted: {refusal}
          </p>
        )}
        {plan && (
          <div className="grid gap-3 text-sm">
            <p>
              {usd(plan.currentCents)} → {usd(plan.originalCents)}, as it came in, and {usd(plan.extraCents)} paid
              alongside it, {usd(plan.partCents)} each.
            </p>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal">Person</th>
                  <th className="text-right font-normal">Share here</th>
                  <th className="text-right font-normal">Owes you</th>
                  <th className="text-right font-normal">Paid</th>
                  <th className="text-right font-normal">Credit</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums whitespace-nowrap">
                {plan.people.map((p) => (
                  <tr key={p.personId}>
                    <td className="font-sans">{p.isOwner ? 'You' : p.name}</td>
                    <td className="text-right">
                      {usd(p.shareBefore)} → {usd(p.shareAfter)} + {usd(p.extraShare)}
                    </td>
                    <td className="text-right">{p.isOwner ? '—' : `${usd(p.before.owed)} → ${usd(p.after.owed)}`}</td>
                    <td className="text-right">{p.isOwner ? '—' : `${usd(p.before.paid)} → ${usd(p.after.paid)}`}</td>
                    <td className="text-right">{p.isOwner ? '—' : `${usd(p.before.credit)} → ${usd(p.after.credit)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs">
              Your spending: {usd(plan.spending.before)} → {usd(plan.spending.after)}. Insights for {plan.month}:{' '}
              {plan.monthByCategoryUnchanged ? 'every category total unchanged' : 'category totals change'}; the merchant
              list moves {usd(plan.extraCents)} from this row to the new purchase.
            </p>
            <div className="grid gap-1">
              <Label htmlFor="convert-what">What was the extra?</Label>
              <Input
                id="convert-what"
                value={what}
                onChange={(e) => {
                  setWhat(e.target.value);
                  setError(null);
                }}
                placeholder="Gas and food, cash"
              />
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          {refusal ? (
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          ) : (
          <Button
            // Never enabled under a refusal: a changed description clears it.
            disabled={!plan || pending || !what.trim() || error !== null}
            onClick={() =>
              run(
                () => convertToPaidAlongside(row.id, what),
                (r) => ('error' in r ? setError(r.error) : setOpen(false)),
              )
            }
          >
            {pending ? 'Converting…' : 'Convert'}
          </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Keep a raised row raised rather than move its extra out (migration 0037):
// a review held at the row's current amount, with the owner's reason. It ends
// the band's line for the row while the amount stays; Move stays offered.
function KeepRaisedButton({ row }: { row: TransactionRow }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { run, pending } = useAction();
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        Keep it raised
      </Button>
    );
  }
  return (
    <span className="flex w-full flex-wrap items-end gap-2">
      <label className="grid min-w-0 flex-1 basis-56 gap-1">
        <span className="text-muted-foreground">Why keep {usd(row.amountCents)}? It is kept with this amount.</span>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} className="h-8 rounded-md border bg-background px-2 text-xs" />
      </label>
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs"
        disabled={pending || text.trim().length === 0}
        onClick={() => run(() => recordRaisedRowReview({ transactionId: row.id, amountCents: row.amountCents, note: text }), (r) => !('error' in r) && setOpen(false))}
      >
        Keep raised
      </Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}
