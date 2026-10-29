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
  hasSplit,
}: {
  row: TransactionRow;
  // The charge this row was paid alongside, when it is such a purchase.
  alongsideOf: AlongsideLink | null;
  // What was paid alongside this row.
  alongside: AlongsideLink[];
  hasSplit: boolean;
}) {
  const synced = row.bankAccountId !== null;
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
      <div className="flex flex-wrap gap-2">
        {!alongsideOf && <AddAlongsideButton row={row} />}
        {row.editedAfterImport && !synced && hasSplit && <ConvertButton row={row} />}
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
        {refusal && <p className="text-sm">{refusal}</p>}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
