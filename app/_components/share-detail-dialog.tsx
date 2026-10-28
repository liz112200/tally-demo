'use client';

import { useState, type ReactElement, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { formatUSD, toCents } from '@/lib/money';
import type { PersonShare } from '@/app/_lib/person-share';

const METHOD_NOTES: Record<PersonShare['method'], string> = {
  equal: 'split equally',
  amount: 'split by amount',
  percent: 'split by percent',
  item: 'split by receipt items',
};

const STATUS_LABELS: Record<PersonShare['status'], string> = {
  outstanding: 'Outstanding',
  partial: 'Partly settled',
  settled: 'Settled',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 text-right text-[13px]">{children}</span>
    </div>
  );
}

// Read-only detail for one debt share, opened from a row on /people. This
// replaces the old cross-link to the Expenses table: the question a row
// raises ("what is this and why do I owe it?") is answerable in place, and
// the jump to Expenses stays available as a secondary action for editing.
export function ShareDetailDialog({
  share,
  personName,
  direction,
  trigger,
}: {
  share: PersonShare;
  personName: string;
  direction: 'incoming' | 'outgoing';
  trigger: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const owes = direction === 'incoming';
  // An external split has no backing transaction, so there is no wider total
  // to frame the share against — the share is the whole of what is owed.
  const total = share.transactionAmountCents;
  const showTotal = total !== null && total !== share.amountCents;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 text-left text-[15px] leading-snug">
            {share.description}
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {owes ? `${personName} owes you` : `You owe ${personName}`}
          </p>
          <p
            className={cn(
              'font-mono text-2xl',
              owes ? 'text-foreground' : 'text-amber-600 dark:text-amber-500',
            )}
          >
            {formatUSD(toCents(share.outstandingCents))}
          </p>
          {share.status === 'partial' && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {formatUSD(toCents(share.allocatedCents))} of{' '}
              {formatUSD(toCents(share.amountCents))} already settled
            </p>
          )}
          {share.status === 'settled' && (
            <p className="mt-0.5 text-[11px] text-positive">
              Fully settled — {formatUSD(toCents(share.amountCents))} paid
            </p>
          )}
        </div>

        <div className="divide-y">
          <Field label="Date">
            <span className="font-mono">{share.date}</span>
          </Field>
          <Field label="Status">{STATUS_LABELS[share.status]}</Field>
          {share.category && <Field label="Category">{share.category}</Field>}
          <Field label="Their share">
            <span className="font-mono">{formatUSD(toCents(share.amountCents))}</span>
          </Field>
          {showTotal && (
            <Field label="Full amount">
              <span className="font-mono">{formatUSD(toCents(total))}</span>
              <span className="ml-1.5 text-[11px] text-muted-foreground">
                {METHOD_NOTES[share.method]} across {share.participantCount}
              </span>
            </Field>
          )}
          {share.note && (
            <Field label="Note">
              <span className="text-muted-foreground">{share.note}</span>
            </Field>
          )}
          {share.transactionId === null && (
            <Field label="Source">
              <span className="text-muted-foreground">
                Expense you logged manually
              </span>
            </Field>
          )}
        </div>

        {share.transactionId && (
          <Link
            href={`/?tx=${share.transactionId}`}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ExternalLink className="size-3" aria-hidden />
            Open in Expenses to edit
          </Link>
        )}
      </DialogContent>
    </Dialog>
  );
}
