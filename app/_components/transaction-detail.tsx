'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  Paperclip,
  Pencil,
  ReceiptText,
  Split as SplitIcon,
  StickyNote,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatUSD, toCents } from '@/lib/money';
import { shareStatus } from '@/lib/allocations';
import type { ReceiptView, ReplacementCandidate, TransactionRow } from '@/db/queries';
import { deleteTransaction } from '@/app/_actions/transactions';
import { removeSplit } from '@/app/_actions/splits';
import { getReceiptImageUrls } from '@/app/_actions/receipts';
import {
  EditDetailsButton,
  EditTransactionForm,
} from '@/app/_components/edit-transaction-form';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import { NoteBlock } from '@/app/_components/note-block';
import { BankFlagBlock, dropSentence } from '@/app/_components/bank-flag-block';
import { ReceiptWizardDialog } from '@/app/_components/receipt-wizard';
import {
  SplitDialog,
  displayShareName,
  type PersonOption,
  type SplitSummary,
} from '@/app/_components/split-editor';

const METHOD_NOTES: Record<SplitSummary['method'], string> = {
  equal: 'split equally',
  amount: 'split by amount',
  percent: 'split by percent',
  item: 'split by receipt items',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

// Where the category came from, spelled out (the collapsed row only hints
// at it with the tag icon).
function CategoryProvenance({ row }: { row: TransactionRow }) {
  if (!row.categoryId) {
    return <span className="text-muted-foreground">Uncategorized</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {row.categoryName}
      <span className="inline-flex items-center gap-1 rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {row.categorySource === 'rule' ? (
          <>
            <Zap className="size-2.5" aria-hidden />
            rule
          </>
        ) : row.categorySource === 'manual' ? (
          <>
            <span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden />
            manual
          </>
        ) : (
          '—'
        )}
      </span>
    </span>
  );
}

// Thumbnail via a short-lived presigned URL fetched when the panel opens;
// the canonical blob URL never reaches the client.
function ReceiptBlock({
  row,
  receipt,
  persons,
}: {
  row: TransactionRow;
  receipt: ReceiptView | null;
  persons: PersonOption[];
}) {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const receiptId = receipt?.id ?? null;
  const imageCount = receipt?.blobUrls.length ?? 0;

  useEffect(() => {
    if (!receiptId) return;
    let cancelled = false;
    getReceiptImageUrls(row.id).then((result) => {
      if (cancelled) return;
      if ('urls' in result) setImageUrls(result.urls);
      else setProblem(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [receiptId, row.id]);

  if (!receipt) {
    if (row.pending) {
      return (
        <p className="text-xs text-muted-foreground">
          Pending at the bank — a receipt can be attached once it posts.
        </p>
      );
    }
    if (!row.isSplittable) {
      return (
        <p className="text-xs text-muted-foreground">
          No receipt — not available for non-splittable rows.
        </p>
      );
    }
    return (
      <ReceiptWizardDialog
        transactionId={row.id}
        description={row.descriptionRaw}
        date={row.date}
        amountCents={row.amountCents}
        persons={persons}
        existingReceipt={null}
        trigger={
          <Button type="button" variant="outline" size="sm">
            <Paperclip data-icon="inline-start" />
            Attach receipt
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex items-start gap-3">
      {imageUrls.length > 0 ? (
        <span className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrls[0]}
            alt={`Receipt from ${receipt.merchant || 'merchant'}`}
            className="max-h-24 w-16 rounded border object-cover object-top"
          />
          {imageCount > 1 && (
            <span className="absolute right-0.5 top-0.5 rounded bg-foreground/80 px-1 text-[9px] font-medium text-background">
              1/{imageCount}
            </span>
          )}
        </span>
      ) : (
        <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded border bg-muted/40">
          <ReceiptText className="size-4 text-muted-foreground/60" aria-hidden />
        </div>
      )}
      <div className="min-w-0 space-y-1 text-xs">
        <p className="truncate">
          {receipt.merchant || 'Receipt'}
          {receipt.date && (
            <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
              {receipt.date}
            </span>
          )}
        </p>
        <p className="font-mono text-muted-foreground">
          {receipt.items.length} item{receipt.items.length === 1 ? '' : 's'} ·{' '}
          {formatUSD(toCents(receipt.totalCents))}
          {imageCount > 1 && ` · ${imageCount} images`}
        </p>
        {problem && <p className="text-destructive">{problem}</p>}
        <ReceiptWizardDialog
          transactionId={row.id}
          description={row.descriptionRaw}
          date={row.date}
          amountCents={row.amountCents}
          persons={persons}
          existingReceipt={receipt}
          trigger={
            <Button type="button" variant="outline" size="sm" className="h-6.5 text-xs">
              View receipt
            </Button>
          }
        />
      </div>
    </div>
  );
}

function SplitBlock({
  row,
  split,
  receipt,
  persons,
  defaultParticipantIds,
}: {
  row: TransactionRow;
  split: SplitSummary | null;
  receipt: ReceiptView | null;
  persons: PersonOption[];
  defaultParticipantIds: string[];
}) {
  if (!split) {
    if (row.pending) {
      return (
        <p className="text-xs text-muted-foreground">
          Pending at the bank — it can be split once it posts, when the amount is final (tips land late).
        </p>
      );
    }
    if (!row.isSplittable) {
      return (
        <p className="text-xs text-muted-foreground">
          Not splittable — credits, rent, transfers and income stay yours.
        </p>
      );
    }
    return (
      <SplitDialog
        transactionId={row.id}
        description={row.descriptionRaw}
        date={row.date}
        amountCents={row.amountCents}
        persons={persons}
        existing={null}
        defaultParticipantIds={defaultParticipantIds}
        receipt={receipt}
        trigger={
          <Button type="button" variant="outline" size="sm">
            <Users data-icon="inline-start" />
            Split with people
          </Button>
        }
      />
    );
  }

  const ownerId = persons.find((p) => p.isOwner)?.id;

  return (
    <div className="space-y-2">
      <ul className="grid max-w-80 gap-0.5">
        {split.shares.map((share) => {
          // The owner's own share is their portion of what they paid, never a
          // debt — no settlement status applies. Every other participant's
          // share can be paid down by settlements, so show its status.
          const isOwnerShare = share.personId === ownerId;
          const status = isOwnerShare
            ? null
            : shareStatus({
                amountCents: share.amountCents,
                allocatedCents: share.allocatedCents,
              });
          return (
            <li
              key={share.personId}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              {/* Cross-link: jump to this person's expanded row on /people. */}
              <Link
                href={`/people?person=${share.personId}`}
                className={cn(
                  'underline-offset-2 hover:underline',
                  share.personDeleted && 'italic text-muted-foreground',
                )}
              >
                {displayShareName(share)}
              </Link>
              <span className="flex items-baseline gap-1.5">
                {status?.status === 'settled' && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wide text-positive"
                    title="Fully settled"
                  >
                    <Check className="size-2.5" aria-hidden />
                    settled
                  </span>
                )}
                {status?.status === 'partial' && (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title={`${formatUSD(toCents(status.outstandingCents))} still outstanding`}
                  >
                    {formatUSD(toCents(status.outstandingCents))} left
                  </span>
                )}
                <span
                  className={cn(
                    'font-mono',
                    status?.status === 'settled' && 'text-muted-foreground line-through',
                  )}
                >
                  {formatUSD(toCents(share.amountCents))}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {METHOD_NOTES[split.method]}
        {(split.taxCents > 0 || split.tipCents > 0) &&
          ` · tax ${formatUSD(toCents(split.taxCents))} + tip ${formatUSD(
            toCents(split.tipCents),
          )} shared equally`}
      </p>
      <div className="flex items-center gap-1.5">
        <SplitDialog
          transactionId={row.id}
          description={row.descriptionRaw}
          date={row.date}
          amountCents={row.amountCents}
          persons={persons}
          existing={split}
          defaultParticipantIds={defaultParticipantIds}
          receipt={receipt}
          trigger={
            <Button type="button" variant="outline" size="sm" className="h-6.5 text-xs">
              <Pencil data-icon="inline-start" />
              Edit split
            </Button>
          }
        />
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 data-icon="inline-start" />
              Remove split
            </Button>
          }
          title="Remove the split?"
          description={`The row becomes entirely yours. ${dropSentence(split, ownerId)}`}
          confirmLabel="Remove split"
          pendingLabel="Removing…"
          onConfirm={async () => {
            const fd = new FormData();
            fd.set('transactionId', row.id);
            return removeSplit(fd);
          }}
        />
      </div>
    </div>
  );
}

// The inline detail panel under an expanded row: full description and
// category provenance, then the split and receipt blocks (the receipt
// affordance lives here now, not on row hover), and soft delete.
export function TransactionDetailPanel({
  row,
  split,
  receipt,
  persons,
  defaultParticipantIds,
  replacementCandidates,
  creditByPerson,
}: {
  row: TransactionRow;
  split: SplitSummary | null;
  receipt: ReceiptView | null;
  persons: PersonOption[];
  defaultParticipantIds: string[];
  replacementCandidates: ReplacementCandidate[];
  creditByPerson: Record<string, number>;
}) {
  // Inline edit of description / amount / date (phase 7); the form
  // replaces the static description block while open. Synced rows are the
  // bank's and offer no edit (BANK-SYNC.md).
  const [editing, setEditing] = useState(false);
  const synced = row.bankAccountId !== null;
  const ownerId = persons.find((p) => p.isOwner)?.id;

  return (
    <div className="animate-in fade-in-0 slide-in-from-top-1 grid gap-4 bg-muted/30 px-4 py-3 duration-200 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0 space-y-3">
        <BankFlagBlock
          row={row}
          split={split}
          receipt={receipt}
          persons={persons}
          defaultParticipantIds={defaultParticipantIds}
          candidates={replacementCandidates}
          creditByPerson={creditByPerson}
        />
        <div>
          <SectionLabel>Description</SectionLabel>
          {editing ? (
            <EditTransactionForm
              // Remount when the saved values change: the inputs are
              // uncontrolled, and a revalidation would otherwise swap
              // their defaultValue under a mounted form.
              key={`${row.date}|${row.amountCents}|${row.descriptionRaw}`}
              row={row}
              hasSplit={split !== null}
              onClose={() => setEditing(false)}
            />
          ) : (
            <>
              <p className="break-words text-[13px]">{row.descriptionRaw}</p>
              <p className="mt-1 text-xs">
                <CategoryProvenance row={row} />
              </p>
              <div className="mt-1.5">
                {synced ? (
                  <p className="text-[11px] text-muted-foreground">
                    From a linked account: date, amount and description follow the bank.
                  </p>
                ) : (
                  <EditDetailsButton onClick={() => setEditing(true)} />
                )}
              </div>
            </>
          )}
        </div>
        <section>
          <SectionLabel>
            <StickyNote className="mr-1 inline size-3 align-[-2px]" aria-hidden />
            Note
          </SectionLabel>
          <NoteBlock transactionId={row.id} note={row.note} />
        </section>
        <div className="grid gap-4 sm:grid-cols-2">
          <section>
            <SectionLabel>
              <SplitIcon className="mr-1 inline size-3 align-[-2px]" aria-hidden />
              Split
            </SectionLabel>
            <SplitBlock
              row={row}
              split={split}
              receipt={receipt}
              persons={persons}
              defaultParticipantIds={defaultParticipantIds}
            />
          </section>
          <section>
            <SectionLabel>
              <ReceiptText className="mr-1 inline size-3 align-[-2px]" aria-hidden />
              Receipt
            </SectionLabel>
            <ReceiptBlock row={row} receipt={receipt} persons={persons} />
          </section>
        </div>
      </div>
      <div className="self-end justify-self-end">
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 data-icon="inline-start" />
              Delete transaction
            </Button>
          }
          title="Delete this transaction?"
          description={
            split
              ? `Its split stops counting toward balances. ${dropSentence(split, ownerId)}${synced ? '' : ' The dedup entry stays, so a re-import will not bring it back.'}`
              : synced
                ? 'It disappears from every view. Syncing will not bring it back.'
                : 'It disappears from every view. The dedup entry stays, so a re-import will not bring it back.'
          }
          confirmLabel="Delete transaction"
          pendingLabel="Deleting…"
          onConfirm={async () => {
            const fd = new FormData();
            fd.set('id', row.id);
            return deleteTransaction(fd);
          }}
        />
      </div>
    </div>
  );
}
