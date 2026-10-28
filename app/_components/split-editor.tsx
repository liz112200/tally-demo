'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Split as SplitIcon, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  toCents,
  tryParseDollars,
  formatUSD,
  formatCents,
  distributeRemainder,
  type Cents,
} from '@/lib/money';
import { computeShares, type ResolvedShare } from '@/lib/split';
import { saveSplit, removeSplit } from '@/app/_actions/splits';
import { getReceiptImageUrls } from '@/app/_actions/receipts';
import { InlineAction } from './inline-action';
import type { ReceiptView } from '@/db/queries';
import {
  SPLIT_METHODS,
  type SplitMethodInput,
  type SplitMethodDisplay,
  type SplitFormState,
} from '@/app/_lib/schema';
import { useReportSuccess } from './page-result';

export type PersonOption = {
  id: string;
  name: string;
  isOwner: boolean;
};

export type SplitSummary = {
  method: SplitMethodDisplay;
  taxCents: number;
  tipCents: number;
  shares: {
    personId: string;
    personName: string;
    personDeleted: boolean;
    amountCents: number;
    // Settlement allocations against this share (for per-participant status).
    allocatedCents: number;
    inputAmountCents: number | null;
    inputPercent: number | null;
  }[];
};

const METHOD_LABELS: Record<SplitMethodInput, string> = {
  equal: 'Equal',
  amount: 'By amount',
  percent: 'By percent',
};

export function displayShareName(share: {
  personName: string;
  personDeleted: boolean;
}): string {
  return share.personDeleted ? '(deleted person)' : share.personName;
}

const initialState: SplitFormState = {};

// The split editor dialog. `persons` is every active person ordered by
// created_at ascending — the same order the engine distributes remainder
// cents in, so the preview here matches what the Server Action stores.
export function SplitDialog({
  transactionId,
  description,
  date,
  amountCents,
  persons,
  existing,
  defaultParticipantIds,
  receipt,
  trigger,
}: {
  transactionId: string;
  description: string;
  date: string;
  amountCents: number;
  persons: PersonOption[];
  existing: SplitSummary | null;
  defaultParticipantIds: string[];
  receipt: ReceiptView | null;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit split' : 'Split transaction'}</DialogTitle>
          <DialogDescription className="flex items-start justify-between gap-3">
            {/* Clamp to two lines: the full description stays visible in the
                expanded row detail, so losing the tail here is fine. */}
            <span className="min-w-0 line-clamp-2">{description}</span>
            <span className="shrink-0 font-mono text-foreground">
              {formatUSD(toCents(amountCents))}
              <span className="ml-2 text-xs text-muted-foreground">{date}</span>
            </span>
          </DialogDescription>
        </DialogHeader>
        {/* Keyed so reopening starts from the saved split, not stale edits. */}
        {open &&
          (existing?.method === 'item' && receipt ? (
            <ItemSplitView
              transactionId={transactionId}
              existing={existing}
              receipt={receipt}
              onRemoved={() => setOpen(false)}
            />
          ) : (
            <SplitForm
              transactionId={transactionId}
              amountCents={amountCents}
              persons={persons}
              existing={existing}
              defaultParticipantIds={defaultParticipantIds}
              onSaved={() => setOpen(false)}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}

function SplitForm({
  transactionId,
  amountCents,
  persons,
  existing,
  defaultParticipantIds,
  onSaved,
}: {
  transactionId: string;
  amountCents: number;
  persons: PersonOption[];
  existing: SplitSummary | null;
  defaultParticipantIds: string[];
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(saveSplit, initialState);
  useReportSuccess(state);
  // 'item' splits never reach this form (the dialog branches to the
  // itemized view first), but the type admits them, so guard anyway.
  const [method, setMethod] = useState<SplitMethodInput>(
    existing && existing.method !== 'item' ? existing.method : 'equal',
  );
  const [selected, setSelected] = useState<Set<string>>(() => {
    const activeIds = new Set(persons.map((p) => p.id));
    const fromExisting = existing?.shares
      .map((s) => s.personId)
      .filter((id) => activeIds.has(id));
    const ids = fromExisting?.length ? fromExisting : defaultParticipantIds;
    return new Set(ids.filter((id) => activeIds.has(id)));
  });
  // A saved amount split shows its stored amounts until the user touches a
  // field — kept separate from manualAmounts so editing one box releases
  // every *other* box to auto-fill immediately (no clearing needed).
  const seedAmounts = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        (existing?.shares ?? [])
          .filter((s) => s.inputAmountCents !== null)
          .map((s) => [s.personId, formatCents(toCents(s.inputAmountCents!))]),
      ),
    [existing],
  );
  // For the amount method, the fields the user has typed into this session
  // are "manual" (pinned); every other selected participant auto-fills with
  // an even share of what's left. `amountsTouched` flips on the first edit:
  // before it, saved amounts show as entered; after it, unpinned fields
  // auto-fill — so changing one person instantly rebalances the rest.
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [amountsTouched, setAmountsTouched] = useState(false);
  const [percentText, setPercentText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (existing?.shares ?? [])
        .filter((s) => s.inputPercent !== null)
        .map((s) => [s.personId, String(s.inputPercent)]),
    ),
  );
  const [taxText, setTaxText] = useState(
    existing && existing.taxCents > 0 ? formatCents(toCents(existing.taxCents)) : '',
  );
  const [tipText, setTipText] = useState(
    existing && existing.tipCents > 0 ? formatCents(toCents(existing.tipCents)) : '',
  );

  useEffect(() => {
    if (state.ok) onSaved();
  }, [state, onSaved]);

  const participants = persons.filter((p) => selected.has(p.id));

  // Amount method: a field is manual (pinned) once typed into; a saved
  // amount shows until any field is touched; everything else auto-fills an
  // even share of what's left of the base (abs(amount) - tax - tip), so
  // entering one or a few amounts never means reaching for a calculator.
  const isManualAmount = (id: string) => (manualAmounts[id]?.trim() ?? '') !== '';
  const showsSeed = (id: string) =>
    !amountsTouched && (seedAmounts[id]?.trim() ?? '') !== '';
  const isAutoAmount = (id: string) => !isManualAmount(id) && !showsSeed(id);
  const amountAuto = useMemo(() => {
    const tax = taxText.trim() === '' ? 0 : (tryParseDollars(taxText) ?? 0);
    const tip = tipText.trim() === '' ? 0 : (tryParseDollars(tipText) ?? 0);
    const base = Math.max(0, Math.abs(amountCents) - Math.max(0, tax) - Math.max(0, tip));
    // Pinned = manual amounts; a pre-touch seed field also holds its value.
    const autoIds = participants.filter((p) => isAutoAmount(p.id)).map((p) => p.id);
    let pinnedSum = 0;
    for (const p of participants) {
      if (isAutoAmount(p.id)) continue;
      const raw = isManualAmount(p.id) ? manualAmounts[p.id] : seedAmounts[p.id];
      const v = tryParseDollars(raw ?? '');
      if (v !== null && v >= 0) pinnedSum += v;
    }
    const remainder = base - pinnedSum;
    const dist =
      autoIds.length > 0 && remainder >= 0
        ? distributeRemainder(toCents(remainder), autoIds.length)
        : autoIds.map(() => toCents(0));
    const autoById = new Map<string, Cents>();
    autoIds.forEach((id, i) => autoById.set(id, dist[i]));
    return autoById;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, manualAmounts, seedAmounts, amountsTouched, taxText, tipText, amountCents]);

  // Effective entered cents for a participant: their typed amount, their
  // saved amount (pre-touch), or the auto share of the remainder.
  const effectiveAmount = (id: string): number | null =>
    isManualAmount(id)
      ? tryParseDollars(manualAmounts[id])
      : showsSeed(id)
        ? tryParseDollars(seedAmounts[id])
        : (amountAuto.get(id) ?? 0);
  // Displayed text in the amount box, following the same three cases.
  const displayAmount = (id: string): string =>
    isManualAmount(id)
      ? manualAmounts[id]
      : showsSeed(id)
        ? seedAmounts[id]
        : formatCents(amountAuto.get(id) ?? toCents(0));

  // Live preview: run the same engine the server runs. Any invalid input
  // surfaces as a message instead of shares, and disables save.
  const preview = useMemo((): { shares: ResolvedShare[] } | { problem: string } => {
    if (participants.length === 0) return { problem: 'Pick at least one participant' };
    const tax = taxText.trim() === '' ? toCents(0) : tryParseDollars(taxText);
    const tip = tipText.trim() === '' ? toCents(0) : tryParseDollars(tipText);
    if (tax === null || tax < 0) return { problem: 'Enter tax as a dollar amount' };
    if (tip === null || tip < 0) return { problem: 'Enter tip as a dollar amount' };

    let inputs: number[] | undefined;
    if (method === 'amount') {
      const parsed = participants.map((p) => effectiveAmount(p.id));
      if (parsed.some((v) => v === null || v < 0)) {
        return { problem: 'Enter a valid dollar amount' };
      }
      inputs = parsed as number[];
    } else if (method === 'percent') {
      const parsed = participants.map((p) => {
        const text = percentText[p.id]?.trim() ?? '';
        if (!/^\d+$/.test(text)) return null;
        return Number(text);
      });
      if (parsed.some((v) => v === null)) {
        return { problem: 'Enter a whole-number percent for every participant' };
      }
      inputs = parsed as number[];
    }

    try {
      return {
        shares: computeShares(
          toCents(amountCents),
          tax,
          tip,
          method,
          participants.map((p) => ({ personId: p.id })),
          inputs,
        ),
      };
    } catch (err) {
      return { problem: err instanceof Error ? friendlyEngineError(err.message) : 'Invalid split' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, method, manualAmounts, seedAmounts, amountsTouched, amountAuto, percentText, taxText, tipText, amountCents]);

  const valid = 'shares' in preview;

  // The payload mirrors what the preview computed; the server re-resolves
  // shares from the same raw inputs. Amount inputs are the effective values
  // (typed or auto-filled), so an auto share persists as a concrete amount.
  const payload = useMemo(() => {
    if (!valid) return null;
    const tax = taxText.trim() === '' ? 0 : tryParseDollars(taxText)!;
    const tip = tipText.trim() === '' ? 0 : tryParseDollars(tipText)!;
    return JSON.stringify({
      transactionId,
      method,
      taxCents: tax,
      tipCents: tip,
      participants: participants.map((p) => ({
        personId: p.id,
        inputAmountCents: method === 'amount' ? effectiveAmount(p.id) : null,
        inputPercent:
          method === 'percent' ? Number(percentText[p.id]?.trim()) : null,
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, transactionId, method, participants, manualAmounts, seedAmounts, amountsTouched, amountAuto, percentText, taxText, tipText]);

  const shareByPerson = valid
    ? new Map(preview.shares.map((s) => [s.personId, s.amountCents]))
    : new Map<string, Cents>();

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="payload" value={payload ?? ''} />
      {/* For the Remove-split formAction; saveSplit reads only `payload`. */}
      <input type="hidden" name="transactionId" value={transactionId} />

      {/* Method segmented control */}
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-[13px]">
        {SPLIT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMethod(m)}
            aria-pressed={method === m}
            className={cn(
              'rounded-md px-2 py-1 transition-colors',
              method === m
                ? 'bg-card font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {METHOD_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Participants, with per-person inputs for amount/percent methods */}
      <fieldset className="overflow-hidden rounded-lg border">
        <legend className="sr-only">Participants</legend>
        <ul className="divide-y">
          {persons.map((person) => {
            const checked = selected.has(person.id);
            return (
              <li
                key={person.id}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors',
                  !checked && 'text-muted-foreground',
                )}
              >
                <input
                  id={`split-person-${person.id}`}
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(person.id);
                    else next.delete(person.id);
                    setSelected(next);
                  }}
                  className="size-3.5 accent-primary"
                />
                <label
                  htmlFor={`split-person-${person.id}`}
                  className="min-w-0 flex-1 truncate"
                >
                  {person.name}
                  {person.isOwner && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      (you)
                    </span>
                  )}
                </label>
                {checked && method === 'amount' && (
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
                      $
                    </span>
                    <Input
                      // Auto (unpinned) fields show the computed even share,
                      // muted; a manual or saved field shows its own value.
                      value={displayAmount(person.id)}
                      onChange={(e) => {
                        const v = e.target.value;
                        // First keystroke releases the other saved boxes to
                        // auto-fill.
                        setAmountsTouched(true);
                        setManualAmounts((prev) => {
                          const next = { ...prev };
                          if (v.trim() === '') delete next[person.id];
                          else next[person.id] = v;
                          return next;
                        });
                      }}
                      // Select an unpinned value on focus so a keystroke
                      // overwrites it cleanly instead of appending.
                      onFocus={(e) => {
                        if (!isManualAmount(person.id)) e.target.select();
                      }}
                      placeholder="0.00"
                      className={cn(
                        'h-6.5 w-24 pl-5 text-right font-mono text-xs',
                        isAutoAmount(person.id) && 'text-muted-foreground italic',
                      )}
                      aria-label={`Amount for ${person.name}`}
                    />
                  </div>
                )}
                {checked && method === 'percent' && (
                  <div className="relative">
                    <Input
                      value={percentText[person.id] ?? ''}
                      onChange={(e) =>
                        setPercentText({ ...percentText, [person.id]: e.target.value })
                      }
                      placeholder="0"
                      className="h-6.5 w-16 pr-5 text-right font-mono text-xs"
                      aria-label={`Percent for ${person.name}`}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                      %
                    </span>
                  </div>
                )}
                {checked && valid && (
                  <span className="w-20 text-right font-mono text-xs">
                    {formatUSD(shareByPerson.get(person.id) ?? toCents(0))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {method === 'amount' && (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          Type an amount for anyone; the greyed amounts split what&apos;s left
          evenly. Clear a field to hand it back to the split.
        </p>
      )}

      {/* Tax and tip, divided equally among participants */}
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['Tax', taxText, setTaxText],
            ['Tip', tipText, setTipText],
          ] as const
        ).map(([label, value, set]) => (
          <label key={label} className="grid gap-1 text-xs text-muted-foreground">
            {label}
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs">
                $
              </span>
              <Input
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder="0.00"
                className="pl-6 text-right font-mono"
              />
            </div>
          </label>
        ))}
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground">
        Tax and tip are split equally among everyone in the split.
      </p>

      {!valid && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {preview.problem}
        </p>
      )}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}

      <div className="flex items-center justify-between gap-2">
        {existing ? (
          <RemoveSplitButton transactionId={transactionId} onRemoved={onSaved} />
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={pending || !valid}>
          {pending ? 'Saving…' : existing ? 'Save changes' : 'Save split'}
        </Button>
      </div>
    </form>
  );
}

// Read-only view of an item split: the itemized breakdown with assignee
// names, the equal tax/tip note, resolved shares, and the receipt image on
// demand (short-lived presigned URL minted server-side). Editing goes
// through the receipt wizard (the rcpt badge); here a split can only be
// removed, which keeps the receipt attached.
function ItemSplitView({
  transactionId,
  existing,
  receipt,
  onRemoved,
}: {
  transactionId: string;
  existing: SplitSummary;
  receipt: ReceiptView;
  onRemoved: () => void;
}) {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);

  const nameByPerson = new Map(
    existing.shares.map((s) => [s.personId, displayShareName(s)]),
  );

  async function viewReceipt() {
    setLoadingImage(true);
    setImageProblem(null);
    const result = await getReceiptImageUrls(transactionId);
    setLoadingImage(false);
    if ('urls' in result) setImageUrls(result.urls);
    else setImageProblem(result.error);
  }

  return (
    <div className="grid gap-3">
      <div className="overflow-hidden rounded-lg border">
        <ul className="divide-y">
          {receipt.items.map((item) => (
            <li key={item.id} className="flex items-baseline gap-2 px-3 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{item.description}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {item.assignedPersonIds.length === 0
                  ? 'yours'
                  : item.assignedPersonIds
                      .map((id) => nameByPerson.get(id) ?? '(deleted person)')
                      .join(' · ')}
              </span>
              <span className="shrink-0 font-mono text-xs">
                {formatUSD(toCents(item.amountCents))}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {(existing.taxCents > 0 || existing.tipCents > 0) && (
        <p className="text-[11px] text-muted-foreground">
          Tax {formatUSD(toCents(existing.taxCents))} + tip{' '}
          {formatUSD(toCents(existing.tipCents))}, split equally among
          participants.
        </p>
      )}

      <div className="rounded-lg bg-muted/60 px-3 py-2">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Resolved shares
        </p>
        <ul className="grid gap-0.5">
          {existing.shares.map((s) => (
            <li key={s.personId} className="flex items-baseline justify-between text-xs">
              <span>{displayShareName(s)}</span>
              <span className="font-mono">{formatUSD(toCents(s.amountCents))}</span>
            </li>
          ))}
        </ul>
      </div>

      {imageUrls.length > 0 ? (
        <div className="grid gap-2">
          {imageUrls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt={`Receipt from ${receipt.merchant || 'merchant'} (${i + 1} of ${imageUrls.length})`}
              className="max-h-72 justify-self-center rounded-lg border object-contain"
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={viewReceipt}
            disabled={loadingImage}
          >
            {loadingImage
              ? 'Loading…'
              : receipt.blobUrls.length > 1
                ? `View ${receipt.blobUrls.length} images`
                : 'View receipt'}
          </Button>
          {imageProblem && <p className="text-xs text-destructive">{imageProblem}</p>}
        </div>
      )}

      <div className="flex justify-between">
        <RemoveSplitButton transactionId={transactionId} onRemoved={onRemoved} />
        <p className="self-center text-[11px] text-muted-foreground">
          Edit items via the rcpt badge; removing keeps the receipt.
        </p>
      </div>
    </div>
  );
}

// Removes the split from inside the split dialog, which closes on success.
function RemoveSplitButton({ transactionId, onRemoved }: { transactionId: string; onRemoved: () => void }) {
  return (
    <InlineAction
      icon={<Trash2 data-icon="inline-start" />}
      label="Remove split"
      pendingLabel="Removing…"
      action={() => {
        const fd = new FormData();
        fd.set('transactionId', transactionId);
        return removeSplit(fd);
      }}
      onSuccess={onRemoved}
    />
  );
}

// The engine reports sums in cents; translate the common mismatches into
// dollar phrasing for the dialog.
function friendlyEngineError(message: string): string {
  const m = message.match(/^Amounts sum to (-?\d+) cents but must sum to (-?\d+) cents$/);
  if (m) {
    return `Amounts add up to ${formatUSD(toCents(Number(m[1])))} but need to reach ${formatUSD(toCents(Number(m[2])))}`;
  }
  const p = message.match(/^Percents sum to (\d+)/);
  if (p) return `Percents add up to ${p[1]}% but must total 100%`;
  const t = message.match(/exceed the transaction total/);
  if (t) return 'Tax and tip exceed the transaction amount';
  return message;
}

// Row affordance: a badge when a split exists, a ghost button when the row
// is splittable, nothing otherwise (muting for non-splittable rows is the
// table's concern).
export function SplitCell({
  transactionId,
  description,
  date,
  amountCents,
  isSplittable,
  persons,
  existing,
  defaultParticipantIds,
  receipt,
}: {
  transactionId: string;
  description: string;
  date: string;
  amountCents: number;
  isSplittable: boolean;
  persons: PersonOption[];
  existing: SplitSummary | null;
  defaultParticipantIds: string[];
  receipt: ReceiptView | null;
}) {
  if (!isSplittable && !existing) return null;

  const trigger = existing ? (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded border border-primary/40 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-primary transition-colors hover:bg-primary/10"
      title={existing.shares
        .map((s) => `${displayShareName(s)} ${formatUSD(toCents(s.amountCents))}`)
        .join(' · ')}
    >
      <SplitIcon className="size-2.5" aria-hidden />
      {existing.shares.length}
    </button>
  ) : (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/row:opacity-100"
      aria-label={`Split ${description}`}
    >
      <SplitIcon className="size-2.5" aria-hidden />
      Split
    </button>
  );

  return (
    <SplitDialog
      transactionId={transactionId}
      description={description}
      date={date}
      amountCents={amountCents}
      persons={persons}
      existing={existing}
      defaultParticipantIds={defaultParticipantIds}
      receipt={receipt}
      trigger={trigger}
    />
  );
}
