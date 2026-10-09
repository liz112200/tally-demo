'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { HandCoins, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatCents, formatUSD, toCents, tryParseDollars } from '@/lib/money';
import {
  fifoSelection,
  groupByMonth,
  groupState,
  parseApplied,
  rangeBetween,
  setShares,
  sharesInRange,
  toAllocationPayload,
  totalOutstanding,
  type GroupState,
  type Selection,
} from '@/lib/settle-selection';
import { planNetting, type NettingResult } from '@/lib/netting';
import { recordPickedSettlement } from '@/app/_actions/settlements';
import type { SettlementFormState } from '@/app/_lib/schema';

type Direction = 'incoming' | 'outgoing';

// One share as the picker lists it, in FIFO order. When editing a settlement,
// outstandingCents includes what that settlement had applied to the share.
export type AllocatorShare = {
  shareId: string;
  date: string;
  description: string;
  category: string | null;
  amountCents: number;
  outstandingCents: number;
};

// How the picker opens. `direction` is the inline form's toggle: the side a
// typed amount is FIFO-seeded on, and where cash goes if the sides cancel.
export type PickerStart = {
  replaceId: string | null; // the settlement being edited, if any
  direction: Direction;
  date: string;
  note: string;
  // New payment: a typed inline amount pins the payment and pre-selects its
  // FIFO fill. 'all' (Settle up) ticks every share on both sides instead.
  amountText: string;
  preselect: 'all' | null;
  // Edit: the settlement's own allocations, and its cash when that cash
  // carried leftover credit (otherwise the payment follows the selection).
  selection: Selection | null;
  pinnedCashText: string | null;
};

const initialState: SettlementFormState = {};

// Manual settlement allocation, in both directions. Ticking a share applies
// its full outstanding; typing into Apply is only for a partial payment. When
// shares are ticked on both sides the payment is netted: the smaller side is
// cleared by an offset pair and only the difference is recorded as cash. The
// payment follows that net until the user types one — leftover then becomes
// credit, and a shortfall blocks Record.
export function SettleAllocatorDialog({
  open,
  onOpenChange,
  personId,
  personName,
  incoming,
  outgoing,
  start,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personId: string;
  personName: string;
  incoming: AllocatorShare[];
  outgoing: AllocatorShare[];
  start: PickerStart;
  onRecorded: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Open on the filter, not the first field (Payment): typing narrows
        // the list straight away, and "/" is never swallowed by an input.
        initialFocus={() => document.getElementById('alloc-filter')}
        className="flex max-h-[calc(100dvh-3rem)] flex-col gap-0 p-0 sm:max-w-[min(64rem,calc(100%-4rem))]"
      >
        {/* Mounted only while open, so every open starts from `start`. */}
        {open && (
          <AllocatorBody
            personId={personId}
            personName={personName}
            incoming={incoming}
            outgoing={outgoing}
            start={start}
            onCancel={() => onOpenChange(false)}
            onRecorded={onRecorded}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function initialSelection(start: PickerStart, incoming: AllocatorShare[], outgoing: AllocatorShare[]) {
  if (start.selection) return start.selection;
  if (start.preselect === 'all') return setShares({}, [...incoming, ...outgoing], true);
  const cents = tryParseDollars(start.amountText);
  if (cents !== null && cents > 0) {
    return fifoSelection(cents, start.direction === 'incoming' ? incoming : outgoing);
  }
  return {};
}

function AllocatorBody({
  personId,
  personName,
  incoming,
  outgoing,
  start,
  onCancel,
  onRecorded,
}: {
  personId: string;
  personName: string;
  incoming: AllocatorShare[];
  outgoing: AllocatorShare[];
  start: PickerStart;
  onCancel: () => void;
  onRecorded: () => void;
}) {
  const [state, formAction, pending] = useActionState(recordPickedSettlement, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  const seededCents = start.selection ? null : tryParseDollars(start.amountText);
  const pinnedStart =
    start.pinnedCashText ?? (seededCents !== null && seededCents > 0 ? start.amountText : null);
  const [selection, setSelection] = useState<Selection>(() =>
    initialSelection(start, incoming, outgoing),
  );
  const [paymentPinned, setPaymentPinned] = useState(pinnedStart !== null);
  const [paymentText, setPaymentText] = useState(pinnedStart ?? '');
  const [date, setDate] = useState(start.date);
  const [note, setNote] = useState(start.note);
  // In-progress Apply edits, committed (parsed and clamped) on blur or Enter.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (state.ok) onRecorded();
  }, [state, onRecorded]);

  const shares = [...incoming, ...outgoing];
  const twoSided = incoming.length > 0 && outgoing.length > 0;
  const incomingPayload = toAllocationPayload(selection, incoming);
  const outgoingPayload = toAllocationPayload(selection, outgoing);
  const incomingSel = incomingPayload.reduce((acc, a) => acc + a.amountCents, 0);
  const outgoingSel = outgoingPayload.reduce((acc, a) => acc + a.amountCents, 0);
  const selectedCount = incomingPayload.length + outgoingPayload.length;
  const netCents = Math.abs(incomingSel - outgoingSel);

  const pinnedCents = paymentPinned ? (tryParseDollars(paymentText) ?? 0) : null;
  const result = planNetting(incomingPayload, outgoingPayload, pinnedCents, start.direction);
  const paymentCents = pinnedCents ?? netCents;
  const canRecord = !pending && result.ok && selectedCount > 0;

  const [filter, setFilter] = useState('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  // Shift-click anchor: the share last toggled.
  const anchorRef = useRef<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  const needle = filter.trim().toLowerCase();
  const matches = (s: AllocatorShare) =>
    !needle || `${s.date} ${s.description} ${s.category ?? ''}`.toLowerCase().includes(needle);
  const visibleIncoming = incoming.filter(matches);
  const visibleOutgoing = outgoing.filter(matches);
  // On-screen order: their side, then yours. Shift-click spans this order.
  const visible = [...visibleIncoming, ...visibleOutgoing];
  const months = groupByMonth([...shares].sort((x, y) => x.date.localeCompare(y.date)));
  const multiYear = new Set(months.map((g) => g.key.slice(0, 4))).size > 1;
  const hiddenSelected = selectedCount - visible.filter((s) => s.shareId in selection).length;
  const ranged = rangeFrom || rangeTo ? sharesInRange(shares, rangeFrom, rangeTo) : [];

  // Toggle one share, or with shift the run from the anchor to it in the
  // order on screen, every share in the run taking the clicked one's new state.
  const toggleRow = (share: AllocatorShare, shift: boolean) => {
    const select = !(share.shareId in selection);
    const run = shift ? rangeBetween(visible, anchorRef.current, share.shareId) : [share];
    setSelection((sel) => setShares(sel, run, select));
    anchorRef.current = share.shareId;
  };

  // Group toggles (chips, section and month headers): a fully selected group
  // clears, anything less fills the whole group.
  const toggleGroup = (list: readonly AllocatorShare[]) => {
    const full = groupState(selection, list) === 'all';
    setSelection((sel) => setShares(sel, list, !full));
  };

  // Arrow keys walk the row checkboxes; Space (native) toggles.
  const moveFocus = (from: HTMLElement, delta: number) => {
    const boxes = Array.from(
      tbodyRef.current?.querySelectorAll<HTMLElement>('[data-row-check]') ?? [],
    );
    const i = boxes.indexOf(from);
    boxes[Math.min(boxes.length - 1, Math.max(0, i + delta))]?.focus();
  };

  // Dialog-wide keys, bound on the document so they work wherever focus sits
  // inside the popup: "/" jumps to the filter, Cmd/Ctrl-Enter records, and a
  // bare Enter in a field never submits implicitly.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Blur first so a pending Apply edit commits, then submit only if the
        // re-rendered Record button is enabled — the hard block still holds.
        (document.activeElement as HTMLElement | null)?.blur();
        requestAnimationFrame(() => {
          const form = formRef.current;
          const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (form && submit && !submit.disabled) form.requestSubmit(submit);
        });
      } else if (e.key === 'Enter' && typing && formRef.current?.contains(e.target as Node)) {
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const commitDraft = (share: AllocatorShare) => {
    const text = drafts[share.shareId];
    if (text === undefined) return;
    setDrafts(({ [share.shareId]: _, ...rest }) => rest);
    const cents = text.trim() === '' ? 0 : parseApplied(text, share.outstandingCents);
    if (cents === null) return;
    setSelection((sel) => {
      const next: Record<string, number> = { ...sel };
      if (cents > 0) next[share.shareId] = cents;
      else delete next[share.shareId];
      return next;
    });
  };

  // A server error describes the submit that produced it; any edit after
  // that retires it so the footer goes back to live status.
  const [dismissed, setDismissed] = useState<SettlementFormState>(state);
  useEffect(() => {
    setDismissed(state);
  }, [selection, paymentText, paymentPinned, date, note]);
  const error =
    dismissed === state
      ? undefined
      : (state.errors?.allocations ??
        state.errors?.cash ??
        state.errors?.date ??
        state.errors?.note);

  // What this payment is, by which way the selection nets.
  const kind: Direction | 'offset' =
    selectedCount === 0
      ? start.direction
      : incomingSel > outgoingSel
        ? 'incoming'
        : outgoingSel > incomingSel
          ? 'outgoing'
          : 'offset';
  const title =
    (start.replaceId ? 'Edit · ' : '') +
    (kind === 'incoming'
      ? `Payment from ${personName}`
      : kind === 'outgoing'
        ? `Payment to ${personName}`
        : `Offset with ${personName}`);
  const recordLabel = start.replaceId
    ? 'Save changes'
    : result.ok && !result.plan.cash
      ? 'Record offset'
      : 'Record payment';

  const sides = [
    { key: 'incoming' as const, title: 'They owe you', all: incoming, shares: visibleIncoming },
    { key: 'outgoing' as const, title: 'You owe them', all: outgoing, shares: visibleOutgoing },
  ].filter((side) => side.all.length > 0);
  const all = groupState(selection, visible);
  const sumSelected = (list: readonly AllocatorShare[]) =>
    list.reduce((acc, s) => acc + (selection[s.shareId] ?? 0), 0);

  return (
    <form ref={formRef} action={formAction} className="flex min-h-0 flex-1 flex-col">
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="cash" value={paymentPinned ? paymentText : ''} />
      <input type="hidden" name="fallbackDirection" value={start.direction} />
      <input type="hidden" name="incoming" value={JSON.stringify(incomingPayload)} />
      <input type="hidden" name="outgoing" value={JSON.stringify(outgoingPayload)} />
      <input type="hidden" name="replaceId" value={start.replaceId ?? ''} />

      <DialogHeader className="gap-1 border-b px-4 pt-4 pb-3">
        <DialogTitle className="flex items-baseline gap-2 pr-8">
          {title}
          <span className="rounded border px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {kind === 'incoming' ? 'they paid' : kind === 'outgoing' ? 'you paid' : 'offset'}
          </span>
        </DialogTitle>
        <DialogDescription className="text-xs">
          {twoSided
            ? 'Tick what this payment covers on either side. Whatever you owe them is offset against what they owe you, and only the difference is recorded as money paid.'
            : 'Tick what this payment covers. Each ticked share is paid in full; type a smaller Apply amount for a partial payment.'}
        </DialogDescription>

        <div className="mt-2 grid items-end gap-2 sm:grid-cols-[9rem_9rem_1fr]">
          <div className="grid gap-1">
            <Label htmlFor="alloc-payment" className="text-[11px] text-muted-foreground">
              {twoSided ? 'Money paid' : 'Payment'}
              {!paymentPinned && (
                <span className="font-normal text-muted-foreground/70">
                  · follows {twoSided ? 'net' : 'selection'}
                </span>
              )}
            </Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
                $
              </span>
              <Input
                id="alloc-payment"
                value={paymentPinned ? paymentText : formatCents(toCents(netCents))}
                onChange={(e) => {
                  setPaymentPinned(true);
                  setPaymentText(e.target.value);
                }}
                onFocus={(e) => e.currentTarget.select()}
                className="h-7 pl-5 text-right font-mono text-xs tabular-nums md:text-xs"
              />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="alloc-date" className="text-[11px] text-muted-foreground">
              Date
            </Label>
            <Input
              id="alloc-date"
              name="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-7 font-mono text-xs md:text-xs"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="alloc-note" className="text-[11px] text-muted-foreground">
              Note
            </Label>
            <Input
              id="alloc-note"
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional"
              className="h-7 text-xs md:text-xs"
            />
          </div>
        </div>
      </DialogHeader>

      {/* Quick selection: the common cases in one click. */}
      <div className="space-y-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <QuickChip
            label="Everything"
            detail={`${shares.length}`}
            cents={twoSided ? undefined : totalOutstanding(shares)}
            state={groupState(selection, shares)}
            onClick={() => toggleGroup(shares)}
          />
          {twoSided &&
            sides.map((side) => (
              <QuickChip
                key={side.key}
                label={side.title}
                cents={totalOutstanding(side.all)}
                state={groupState(selection, side.all)}
                onClick={() => toggleGroup(side.all)}
              />
            ))}
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          {months.map((g) => (
            <QuickChip
              key={g.key}
              label={multiYear ? g.label : g.label.slice(0, 3)}
              title={`${g.label} · ${g.shares.length} share${g.shares.length === 1 ? '' : 's'}`}
              // With both sides in a month, a single total would mix what
              // they owe with what you owe; show the count instead.
              cents={twoSided ? undefined : g.totalCents}
              detail={twoSided ? `${g.shares.length}` : undefined}
              state={groupState(selection, g.shares)}
              onClick={() => toggleGroup(g.shares)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Range
          </span>
          <Input
            type="date"
            aria-label="Range start"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            className="h-7 w-34 font-mono text-xs md:text-xs"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="date"
            aria-label="Range end"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            className="h-7 w-34 font-mono text-xs md:text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={ranged.length === 0}
            onClick={() => setSelection((sel) => setShares(sel, ranged, true))}
          >
            {ranged.length > 0
              ? `Select ${ranged.length}${twoSided ? '' : ` · ${formatUSD(toCents(totalOutstanding(ranged)))}`}`
              : 'Select range'}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={filterRef}
                id="alloc-filter"
                type="search"
                aria-label="Filter shares"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && filter) {
                    e.preventDefault();
                    e.stopPropagation();
                    setFilter('');
                  }
                }}
                placeholder="Filter"
                className="h-7 w-48 pr-6 pl-6 text-xs md:text-xs"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              disabled={selectedCount === 0}
              onClick={() => {
                setSelection({});
                setDrafts({});
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Separate borders drawn on the cells: a collapsed <tr> border paints
            unevenly under the overflow-clipped cells in Chrome. */}
        <table className="w-full table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col className="w-9" />
            <col className="w-26" />
            <col />
            <col className="w-32" />
            <col className="w-28" />
            <col className="w-32" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-popover text-[10px] uppercase tracking-wider text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]">
            <tr>
              <th className="py-1.5 pl-4 text-left font-medium">
                <Checkbox
                  aria-label={needle ? 'Select every matching share' : 'Select every share'}
                  checked={all === 'all'}
                  indeterminate={all === 'some'}
                  disabled={visible.length === 0}
                  onCheckedChange={() => toggleGroup(visible)}
                />
              </th>
              <th className="px-2 py-1.5 text-left font-medium">Date</th>
              <th className="px-2 py-1.5 text-left font-medium">Description</th>
              <th className="px-2 py-1.5 text-left font-medium">Category</th>
              <th className="px-2 py-1.5 text-right font-medium">Outstanding</th>
              <th className="py-1.5 pr-4 pl-2 text-right font-medium">Apply</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {sides.map((side) => {
              if (side.shares.length === 0) return null;
              const sState = groupState(selection, side.shares);
              const sApplying = sumSelected(side.shares);
              const sectionRow = twoSided ? (
                <tr
                  key={`side-${side.key}`}
                  className="bg-muted text-[11px] font-medium text-foreground [&>td]:border-b"
                >
                  <td className="py-1.5 pl-4">
                    <Checkbox
                      aria-label={`Select everything in ${side.title}`}
                      checked={sState === 'all'}
                      indeterminate={sState === 'some'}
                      onCheckedChange={() => toggleGroup(side.shares)}
                    />
                  </td>
                  <td colSpan={3} className="px-2 py-1.5">
                    <span className="uppercase tracking-wider">{side.title}</span>
                    <span className="ml-2 font-normal text-muted-foreground">
                      {side.key === 'incoming'
                        ? `what ${personName} owes you`
                        : `what you owe ${personName}`}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {formatUSD(toCents(totalOutstanding(side.shares)))}
                  </td>
                  <td
                    className={cn(
                      'py-1.5 pr-4 pl-2 text-right font-mono tabular-nums',
                      sApplying > 0 && 'text-primary',
                    )}
                  >
                    {sApplying > 0 ? formatUSD(toCents(sApplying)) : '—'}
                  </td>
                </tr>
              ) : null;
              return [
                sectionRow,
                ...groupByMonth(side.shares).flatMap((group) => {
                  const gState = groupState(selection, group.shares);
                  const applying = sumSelected(group.shares);
                  return [
                    <tr
                      key={`${side.key}-${group.key}`}
                      className="bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground [&>td]:border-b"
                    >
                      <td className="py-1 pl-4">
                        <Checkbox
                          aria-label={`Select ${group.label}${twoSided ? ` in ${side.title}` : ''}`}
                          checked={gState === 'all'}
                          indeterminate={gState === 'some'}
                          onCheckedChange={() => toggleGroup(group.shares)}
                        />
                      </td>
                      <td colSpan={3} className="px-2 py-1">
                        <span className="font-medium text-foreground">{group.label}</span>
                        <span className="ml-2 normal-case tracking-normal">
                          {group.shares.length} share{group.shares.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono tracking-normal tabular-nums">
                        {formatUSD(toCents(group.totalCents))}
                      </td>
                      <td
                        className={cn(
                          'py-1 pr-4 pl-2 text-right font-mono tracking-normal tabular-nums',
                          applying > 0 && 'text-primary',
                        )}
                      >
                        {applying > 0 ? formatUSD(toCents(applying)) : '—'}
                      </td>
                    </tr>,
                    ...group.shares.map((share) => (
                      <ShareRow
                        key={share.shareId}
                        share={share}
                        applied={selection[share.shareId]}
                        draft={drafts[share.shareId]}
                        onToggle={(shift) => toggleRow(share, shift)}
                        onMove={moveFocus}
                        onDraft={(text) => setDrafts((d) => ({ ...d, [share.shareId]: text }))}
                        onCommit={() => commitDraft(share)}
                      />
                    )),
                  ];
                }),
              ];
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No shares match &ldquo;{filter}&rdquo;.
          </p>
        )}
      </div>

      <AllocatorFooter
        personName={personName}
        incomingCount={incomingPayload.length}
        outgoingCount={outgoingPayload.length}
        incomingCents={incomingSel}
        outgoingCents={outgoingSel}
        hiddenSelected={hiddenSelected}
        paymentCents={paymentCents}
        paymentPinned={paymentPinned}
        result={result}
        error={error}
        pending={pending}
        canRecord={canRecord}
        recordLabel={recordLabel}
        onMatch={() => setPaymentPinned(false)}
        onCancel={onCancel}
      />
    </form>
  );
}

function AllocatorFooter({
  personName,
  incomingCount,
  outgoingCount,
  incomingCents,
  outgoingCents,
  hiddenSelected,
  paymentCents,
  paymentPinned,
  result,
  error,
  pending,
  canRecord,
  recordLabel,
  onMatch,
  onCancel,
}: {
  personName: string;
  incomingCount: number;
  outgoingCount: number;
  incomingCents: number;
  outgoingCents: number;
  hiddenSelected: number;
  paymentCents: number;
  paymentPinned: boolean;
  result: NettingResult;
  error: string | undefined;
  pending: boolean;
  canRecord: boolean;
  recordLabel: string;
  onMatch: () => void;
  onCancel: () => void;
}) {
  const usd = (cents: number) => (
    <span className="font-mono tabular-nums">{formatUSD(toCents(cents))}</span>
  );
  const selectedCount = incomingCount + outgoingCount;
  const netting = incomingCount > 0 && outgoingCount > 0;
  const allocatedCents = incomingCents + outgoingCents;
  const netCents = Math.abs(incomingCents - outgoingCents);
  const shareWord = (n: number) => `${n} share${n === 1 ? '' : 's'}`;

  const summary = netting ? (
    <>
      They owe {usd(incomingCents)}{' '}
      <span className="text-muted-foreground">({shareWord(incomingCount)})</span> − you owe{' '}
      {usd(outgoingCents)} <span className="text-muted-foreground">({shareWord(outgoingCount)})</span>{' '}
      = net <span className="font-medium">{usd(netCents)}</span>
      {netCents > 0 && (incomingCents > outgoingCents ? ` from ${personName}` : ` to ${personName}`)}
    </>
  ) : (
    <>
      <span className="font-medium">{shareWord(selectedCount)}</span> · applying{' '}
      <span className="font-medium">{usd(allocatedCents)}</span> of {usd(paymentCents)}
    </>
  );

  let status: React.ReactNode;
  if (selectedCount === 0) {
    status = <span className="text-muted-foreground">Nothing selected yet.</span>;
  } else if (!result.ok) {
    status =
      result.reason === 'over' ? (
        <span className="font-medium text-destructive">
          {netting ? (
            <>
              Money paid is {usd(result.overByCents)} short of the net — untick shares or raise it
            </>
          ) : (
            <>Over by {usd(result.overByCents)} — untick shares or raise the payment</>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">Nothing selected yet.</span>
      );
  } else {
    const { plan } = result;
    const parts: React.ReactNode[] = [];
    if (plan.cash && plan.cashCents > 0) {
      parts.push(
        <span key="cash">
          {usd(plan.cashCents)} {plan.cash.direction === 'incoming' ? 'paid by them' : 'paid by you'}
        </span>,
      );
    }
    if (plan.offset) parts.push(<span key="offset">{usd(plan.offsetCents)} offset both ways</span>);
    status = (
      <span className={plan.creditCents > 0 ? 'text-muted-foreground' : 'text-positive'}>
        {netting || plan.offset ? (
          <>
            Records {parts.reduce<React.ReactNode[]>((acc, p, i) => (i ? [...acc, ' + ', p] : [p]), [])}
            {plan.creditCents === 0 && ' — both sides cleared'}
          </>
        ) : plan.creditCents === 0 ? (
          'Payment fully applied'
        ) : null}
        {plan.creditCents > 0 && (
          <>
            {netting || plan.offset ? '; ' : ''}
            <span className="text-foreground">{usd(plan.creditCents)}</span> left over becomes credit
          </>
        )}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/50 px-4 py-3 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p>
          {summary}
          {hiddenSelected > 0 && (
            <span className="text-muted-foreground"> ({hiddenSelected} hidden by filter)</span>
          )}
          {paymentPinned && paymentCents !== netCents && selectedCount > 0 && (
            <button
              type="button"
              onClick={onMatch}
              className="ml-2 text-[11px] text-primary underline-offset-2 hover:underline"
            >
              Match payment to {netting ? 'net' : 'selection'}
            </button>
          )}
        </p>
        <p aria-live="polite">{error ? <span className="text-destructive">{error}</span> : status}</p>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-7" disabled={!canRecord}>
          <HandCoins data-icon="inline-start" />
          {pending ? 'Saving…' : recordLabel}
          <kbd className="ml-1 hidden font-mono text-[10px] opacity-70 sm:inline">⌘↵</kbd>
        </Button>
      </div>
    </div>
  );
}

// A quick-select chip: brass when its whole group is selected, dashed brass
// when part of it is.
function QuickChip({
  label,
  detail,
  title,
  cents,
  state,
  onClick,
}: {
  label: string;
  detail?: string;
  title?: string;
  cents?: number;
  state: GroupState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={state === 'all'}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
        state === 'all' && 'border-primary bg-primary/15 text-foreground',
        state === 'some' && 'border-dashed border-primary/70 text-foreground',
        state === 'none' && 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="font-medium">{label}</span>
      {cents !== undefined && (
        <span className="font-mono tabular-nums">{formatUSD(toCents(cents))}</span>
      )}
      {detail && <span className="text-muted-foreground">· {detail}</span>}
    </button>
  );
}

function ShareRow({
  share,
  applied,
  draft,
  onToggle,
  onMove,
  onDraft,
  onCommit,
}: {
  share: AllocatorShare;
  applied: number | undefined;
  draft: string | undefined;
  onToggle: (shift: boolean) => void;
  onMove: (from: HTMLElement, delta: number) => void;
  onDraft: (text: string) => void;
  onCommit: () => void;
}) {
  const selected = applied !== undefined;
  const partial = selected && applied < share.outstandingCents;
  return (
    <tr
      onClick={(e) => onToggle(e.shiftKey)}
      // Keep shift-click from selecting text across the rows it spans.
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      className={cn(
        'cursor-pointer transition-colors [&>td]:border-b [&>td]:border-border/60',
        selected ? 'bg-primary/[0.07] hover:bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      <td className="py-1 pl-4" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          data-row-check=""
          aria-label={`${share.date} ${share.description}`}
          checked={selected}
          onCheckedChange={(_, details) =>
            onToggle((details.event as MouseEvent | KeyboardEvent).shiftKey)
          }
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              onMove(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
            }
          }}
        />
      </td>
      <td className="px-2 py-1 font-mono text-[11px] text-muted-foreground">{share.date}</td>
      <td className="truncate px-2 py-1" title={share.description}>
        {share.description}
      </td>
      <td className="truncate px-2 py-1 text-muted-foreground">{share.category ?? '—'}</td>
      <td className="px-2 py-1 text-right font-mono tabular-nums">
        {formatUSD(toCents(share.outstandingCents))}
        {share.outstandingCents < share.amountCents && (
          <span className="block text-[10px] text-muted-foreground">
            of {formatUSD(toCents(share.amountCents))}
          </span>
        )}
      </td>
      <td className="py-1 pr-4 pl-2" onClick={(e) => e.stopPropagation()}>
        <div className="relative">
          <span
            className={cn(
              'pointer-events-none absolute inset-y-0 left-1.5 flex items-center text-[11px] text-muted-foreground',
              !selected && 'opacity-40',
            )}
          >
            $
          </span>
          <Input
            aria-label={`Apply to ${share.description}`}
            title={partial ? 'Partial payment' : undefined}
            value={draft ?? (selected ? formatCents(toCents(applied)) : '')}
            placeholder={formatCents(toCents(share.outstandingCents))}
            onChange={(e) => onDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommit();
            }}
            className={cn(
              'h-6 pl-4 text-right font-mono text-[11px] tabular-nums md:text-[11px]',
              // Unselected cells stay quiet: the faint figure is what ticking
              // (or typing here) would apply, not a value already applied.
              !selected &&
                'border-transparent bg-transparent shadow-none placeholder:text-muted-foreground/35 hover:border-input focus-visible:border-ring dark:bg-transparent',
              partial && 'border-primary/60 text-primary',
            )}
          />
        </div>
      </td>
    </tr>
  );
}
