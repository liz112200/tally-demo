'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, ArrowRightLeft, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { formatUSD, toCents } from '@/lib/money';
import { dropOutcome, resaveOutcome, type FlagSplit, type ResaveLine } from '@/lib/flag-outcomes';
import type { ReceiptView, ReplacementCandidate, TransactionRow } from '@/db/queries';
import { dismissBankFlag, moveSplitToReplacement } from '@/app/_actions/bank-flags';
import { deleteTransaction } from '@/app/_actions/transactions';
import { removeSplit } from '@/app/_actions/splits';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import {
  SplitDialog,
  displayShareName,
  type PersonOption,
  type SplitSummary,
} from '@/app/_components/split-editor';

const usd = (mills: number) => formatUSD(toCents(mills));

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function toFlagSplit(split: SplitSummary): FlagSplit {
  return {
    method: split.method,
    taxCents: split.taxCents,
    tipCents: split.tipCents,
    shares: split.shares.map((s) => ({
      personId: s.personId,
      personName: displayShareName(s),
      amountCents: s.amountCents,
      allocatedCents: s.allocatedCents,
      inputAmountCents: s.inputAmountCents,
      inputPercent: s.inputPercent,
    })),
  };
}

// What removing the split (or deleting the row) does, for these people:
// "Ana's $18.02 and Ben's $9.00 become their credit ($27.02), applied to
// their next shares. Ben's remaining $9.02 is no longer owed."
export function dropSentence(split: SplitSummary | null, ownerId: string | undefined): string {
  if (!split) return 'Nobody else had a share in it, so no balance changes.';
  const { lines, creditTotalCents } = dropOutcome(toFlagSplit(split), ownerId);
  const paid = lines.filter((l) => l.paidCents > 0);
  const owed = lines.filter((l) => l.owedCents > 0);
  const parts: string[] = [];
  if (paid.length > 0) {
    parts.push(
      `${joinPhrases(paid.map((l) => `${l.personName}'s ${usd(l.paidCents)}`))} already paid ` +
        `${paid.length === 1 ? 'becomes their credit' : `become their credit (${usd(creditTotalCents)})`}, ` +
        'applied to their next shares.',
    );
  }
  if (owed.length > 0) {
    parts.push(
      `${joinPhrases(owed.map((l) => `${l.personName}'s ${paid.some((p) => p.personId === l.personId) ? 'remaining ' : ''}${usd(l.owedCents)}`))} ` +
        `${owed.length === 1 ? 'is' : 'are'} no longer owed.`,
    );
  }
  if (parts.length === 0) return 'Nobody else had a share in it, so no balance changes.';
  return parts.join(' ');
}

// One person's result of re-saving the split on the new amount.
function resaveSentence(l: ResaveLine): string {
  const paid = l.paidCents > 0 ? `has paid ${usd(l.paidCents)}` : 'has paid nothing toward it';
  if (l.becomesCreditCents > 0) {
    return `${l.personName} ${paid}; ${usd(l.becomesCreditCents)} of that would become their credit.`;
  }
  if (l.creditUsedCents > 0) {
    return l.owesCents > 0
      ? `${l.personName} ${paid}, ${usd(l.creditUsedCents)} of their existing credit would cover more, and they would owe ${usd(l.owesCents)}.`
      : `${l.personName} ${paid}, and ${usd(l.creditUsedCents)} of their existing credit would cover the rest.`;
  }
  return l.owesCents > 0
    ? `${l.personName} ${paid} and would owe ${usd(l.owesCents)}.`
    : `${l.personName} ${paid} and would owe nothing.`;
}

function Option({ action, children }: { action: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-baseline sm:gap-3">
      <div>{action}</div>
      <p className="text-muted-foreground">{children}</p>
    </li>
  );
}

// What bank sync flagged on this row, and the ways to resolve it
// (BANK-SYNC.md). Sync itself changed no balance; each option says what it
// would do to these people and their money before it runs.
export function BankFlagBlock({
  row,
  split,
  receipt,
  persons,
  defaultParticipantIds,
  candidates,
  creditByPerson,
}: {
  row: TransactionRow;
  split: SplitSummary | null;
  receipt: ReceiptView | null;
  persons: PersonOption[];
  defaultParticipantIds: string[];
  candidates: ReplacementCandidate[];
  creditByPerson: Record<string, number>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(candidates.length === 1 ? candidates[0].id : null);
  const ownerId = persons.find((p) => p.isOwner)?.id;

  const dismiss = (flag: 'amount' | 'removed') =>
    startTransition(async () => {
      const result = await dismissBankFlag(row.id, flag);
      setError('error' in result ? result.error : null);
    });

  const smallButton = 'h-6.5 text-xs';

  if (row.bankAmountBeforeCents !== null) {
    const before = row.bankAmountBeforeCents;
    const after = row.amountCents;
    const gap = after - before;
    const outcome = split
      ? resaveOutcome({ newAmountCents: after, split: toFlagSplit(split), ownerId, creditByPerson })
      : null;
    const shareTexts =
      outcome?.kind === 'computed' ? [...new Set(outcome.lines.map((l) => usd(l.newShareCents)))] : [];

    return (
      <div role="status" className="space-y-2.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs">
        <p className="flex items-start gap-1.5 font-medium">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            The bank changed the amount from <span className="font-mono">{usd(before)}</span> to{' '}
            <span className="font-mono">{usd(after)}</span>. The split still divides{' '}
            <span className="font-mono">{usd(before)}</span>, and nobody&apos;s balance has changed yet.
          </span>
        </p>
        <ul className="space-y-2">
          {split && (
            <Option
              action={
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
                    <Button type="button" variant="outline" size="sm" className={smallButton}>
                      <Pencil data-icon="inline-start" />
                      {outcome?.kind === 'computed' ? 'Split the new amount' : 'Open the split'}
                    </Button>
                  }
                />
              }
            >
              {outcome?.kind === 'computed' ? (
                <>
                  {shareTexts.length === 1
                    ? `Saved with the same people, each share becomes ${shareTexts[0]}. `
                    : `Saved with the same people, shares become ${joinPhrases(outcome.lines.map((l) => `${l.personName}'s ${usd(l.newShareCents)}`))}. `}
                  {outcome.lines.map(resaveSentence).join(' ')} Saving clears the review mark.
                </>
              ) : outcome?.kind === 'manual' && outcome.reason === 'item' ? (
                `The shares follow the receipt's items, so saving again gives the same shares; the receipt's total check will show the ${usd(Math.abs(gap))} difference.`
              ) : (
                `The shares were set by hand for ${usd(before)}, so they can't be worked out for ${usd(after)}: the split opens for you to set them, and nothing changes until you save.`
              )}
            </Option>
          )}
          {split && (
            <Option
              action={
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="ghost" size="sm" className={smallButton}>
                      Remove the split
                    </Button>
                  }
                  title="Remove the split?"
                  description={`The whole ${usd(after)} becomes yours. ${dropSentence(split, ownerId)}`}
                  confirmLabel="Remove split"
                  pendingLabel="Removing…"
                  onConfirm={async () => {
                    const fd = new FormData();
                    fd.set('transactionId', row.id);
                    return removeSplit(fd);
                  }}
                />
              }
            >
              The whole {usd(after)} becomes yours. {dropSentence(split, ownerId)}
            </Option>
          )}
          <Option
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${smallButton} text-muted-foreground`}
                disabled={pending}
                onClick={() => dismiss('amount')}
              >
                Keep the split as it is
              </Button>
            }
          >
            Clears the review mark; nobody&apos;s balance changes. The split keeps dividing {usd(before)}
            {gap > 0
              ? `, so the other ${usd(gap)} of the charge stays yours.`
              : `, so people stay charged ${usd(-gap)} more in total than the bank's amount.`}
          </Option>
        </ul>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    );
  }

  if (row.removedByBankAt === null) return null;

  const builtOn = [split && 'split', receipt && 'receipt', row.note && 'note', row.categorySource === 'manual' && 'category']
    .filter(Boolean)
    .join(', ');
  const chosen = candidates.find((c) => c.id === target) ?? null;
  const label = (c: ReplacementCandidate) => `${c.descriptionRaw} (${c.date}, ${usd(c.amountCents)})`;
  const paid = split ? dropOutcome(toFlagSplit(split), ownerId).lines.filter((l) => l.paidCents > 0) : [];
  const paymentsStay =
    paid.length > 0
      ? `${joinPhrases(paid.map((l) => `${l.personName}'s ${usd(l.paidCents)}`))} already paid ${paid.length === 1 ? 'stays' : 'stay'} applied to it`
      : 'every share moves with it';

  return (
    <div role="status" className="space-y-2.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs">
      <p className="flex items-start gap-1.5 font-medium">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
        <span>
          The bank no longer lists this transaction. It was kept because of its {builtOn}, and nobody&apos;s balance has
          changed yet.
        </span>
      </p>
      <ul className="space-y-2">
        {candidates.length > 0 && (
          <Option
            action={
              <div className="flex flex-wrap items-center gap-1.5">
                {candidates.length > 1 && (
                  <Select
                    items={Object.fromEntries(candidates.map((c) => [c.id, label(c)]))}
                    value={target}
                    onValueChange={(v) => setTarget(v)}
                  >
                    <SelectTrigger size="sm" className="h-6.5 max-w-44 text-xs" aria-label="Transaction that replaced this one">
                      {chosen ? label(chosen) : 'Choose the re-sent row…'}
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {label(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={smallButton}
                  disabled={pending || chosen === null}
                  onClick={() =>
                    startTransition(async () => {
                      if (!chosen) return;
                      const result = await moveSplitToReplacement(row.id, chosen.id);
                      setError('error' in result ? result.error : null);
                    })
                  }
                >
                  <ArrowRightLeft data-icon="inline-start" />
                  Move to the re-sent row
                </Button>
              </div>
            }
          >
            {chosen
              ? `Moves the ${builtOn} to ${label(chosen)}: ${paymentsStay}, and no balance changes. This row is then deleted.`
              : `Choose which re-sent row it is. The ${builtOn} moves there, ${paymentsStay}, and no balance changes.`}
          </Option>
        )}
        <Option
          action={
            <ConfirmDialog
              trigger={
                <Button type="button" variant="ghost" size="sm" className={`${smallButton} hover:text-destructive`}>
                  Delete this row
                </Button>
              }
              title="Delete this transaction?"
              description={`The ${usd(row.amountCents)} stops counting. ${dropSentence(split, ownerId)}`}
              confirmLabel="Delete transaction"
              pendingLabel="Deleting…"
              onConfirm={async () => {
                const fd = new FormData();
                fd.set('id', row.id);
                return deleteTransaction(fd);
              }}
            />
          }
        >
          For a reversed charge. The {usd(row.amountCents)} stops counting. {dropSentence(split, ownerId)}
        </Option>
        <Option
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${smallButton} text-muted-foreground`}
              disabled={pending}
              onClick={() => dismiss('removed')}
            >
              Keep it
            </Button>
          }
        >
          Clears the removed mark; the row and its {builtOn} keep counting, and nobody&apos;s balance changes.
          {candidates.length > 0 &&
            ` ${candidates.length === 1 ? label(candidates[0]) : 'The re-sent row'} would count as well: the same charge twice.`}
        </Option>
      </ul>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
