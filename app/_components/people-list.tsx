'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, HandCoins, ListChecks, Pencil, Trash2, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toCents, formatUSD, formatCents } from '@/lib/money';
import { totalOutstanding } from '@/lib/settle-selection';
import {
  createPerson,
  renamePerson,
  deletePerson,
  hardDeletePerson,
} from '@/app/_actions/people';
import { createSettlement, deleteSettlement } from '@/app/_actions/settlements';
import { deleteExternalExpense } from '@/app/_actions/external-expenses';
import { ExternalExpenseDialog } from '@/app/_components/external-expense-dialog';
import {
  SettleAllocatorDialog,
  type AllocatorShare,
  type PickerStart,
} from '@/app/_components/settle-allocator';
import type { PersonFormState, SettlementFormState } from '@/app/_lib/schema';
import {
  nextSort,
  readSort,
  sortPatch,
  sortRows,
  type SortSpec,
  type SortState,
} from '@/lib/table-state';
import { canHardDeletePerson } from '@/lib/people-visibility';
import { useTableState } from '@/app/_lib/use-table-state';
import { SortBar } from '@/app/_components/sort-controls';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import { ShareDetailDialog } from '@/app/_components/share-detail-dialog';
import { ShareListButton } from '@/app/_components/share-list-button';
import type { PersonShare } from '@/app/_lib/person-share';
import type { ShareLine } from '@/lib/share-summary';
import { useReportSuccess } from './page-result';

// PersonShare lives in app/_lib/person-share.ts so the detail dialog can use
// it without a circular import; re-exported here since callers (and the page)
// have always imported it from this module.
export type { PersonShare };

// One payment on /people: a plain settlement, or a netted group — the money
// actually paid plus an offset pair that cancelled debts both ways. `id` is
// any member's id; deleting or editing it takes the whole group.
export type PersonSettlement = {
  id: string;
  date: string;
  note: string | null;
  // The money that moved; null for an offset-only group.
  cash: {
    direction: 'incoming' | 'outgoing';
    amountCents: number;
    unallocatedCents: number;
  } | null;
  offsetCents: number;
  allocations: {
    shareId: string;
    direction: 'incoming' | 'outgoing';
    offset: boolean;
    description: string;
    date: string;
    amountCents: number;
  }[];
};

// One person on /people: identity, net bidirectional balance, and the shares
// and settlements that explain it. The owner gets a PersonView too, but only
// identity fields matter for them (their shares are their own spending).
export type PersonView = {
  id: string;
  name: string;
  isOwner: boolean;
  deleted: boolean;
  addedOn: string;
  theyOweMeCents: number;
  iOweThemCents: number;
  netCents: number;
  // "They owe you" shares (owner-paid, this person's debt).
  incoming: PersonShare[];
  // "You owe them" shares (external, owner's debt to this person).
  outgoing: PersonShare[];
  settlements: PersonSettlement[];
};

export type OutstandingShare = AllocatorShare;

const PEOPLE_SORT: SortSpec = {
  columns: ['added', 'name', 'balance'],
  defaultSort: 'added',
  defaultDir: 'asc',
  firstDir: { balance: 'desc' },
};

const PEOPLE_SORT_OPTIONS = [
  { id: 'name', label: 'name' },
  { id: 'balance', label: 'balance' },
  { id: 'added', label: 'added' },
] as const;

const PERSON_ACCESSORS: Record<string, (person: PersonView) => unknown> = {
  name: (person) => person.name,
  balance: (person) => person.netCents,
  added: (person) => person.addedOn,
};

// Sort of the share list inside one expanded person. Held in component state
// rather than the URL: it is a per-person reading preference, and the page
// already spends ?sort=/?dir= on the people list itself.
//
// Display only. The FIFO allocation order the settlement engine relies on is
// computed server-side (effective date, then created_at, then id) and reaches
// the settlement form through outstandingOf(person.incoming), which reads the
// unsorted array — so reordering here cannot perturb allocation.
const SHARE_SORT: SortSpec = {
  columns: ['date', 'category', 'amount'],
  defaultSort: 'date',
  defaultDir: 'desc',
  firstDir: { date: 'desc', amount: 'desc', category: 'asc' },
};

const SHARE_SORT_OPTIONS = [
  { id: 'date', label: 'date' },
  { id: 'category', label: 'category' },
  { id: 'amount', label: 'amount' },
] as const;

// Sorting keys off outstanding rather than face amount, so "amount" ranks by
// what is actually still owed — the number the row leads with.
const SHARE_ACCESSORS: Record<string, (share: PersonShare) => unknown> = {
  date: (share) => share.date,
  category: (share) => share.category,
  amount: (share) => share.outstandingCents,
};

function sortShares(list: PersonShare[], sort: SortState): PersonShare[] {
  return sortRows(list, SHARE_ACCESSORS[sort.sort], sort.dir);
}

// The share rows, as the plain-text summary wants them.
function toShareLines(shares: PersonShare[]): ShareLine[] {
  return shares.map((s) => ({
    date: s.date,
    // The shared text reads better with the normalized merchant than with
    // the raw bank descriptor the on-screen row shows.
    description: s.merchantLabel || s.description,
    outstandingCents: s.outstandingCents,
    category: s.category,
  }));
}

const initialPersonState: PersonFormState = {};
const initialSettlementState: SettlementFormState = {};

export function PeopleList({
  owner,
  rows,
  owedToOwnerCents,
  owedByOwnerCents,
  debtorCount,
  creditorCount,
  today,
}: {
  owner: PersonView;
  rows: PersonView[];
  owedToOwnerCents: number;
  owedByOwnerCents: number;
  debtorCount: number;
  creditorCount: number;
  today: string;
}) {
  const { params, apply } = useTableState();
  const sort = readSort(params, PEOPLE_SORT);
  const sorted = sortRows(rows, PERSON_ACCESSORS[sort.sort], sort.dir);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Deep link (?person=<id>, e.g. from a participant name on Expenses):
  // expand that person and bring them into view. Manual toggles clear the
  // param so a later reload reflects what is actually open.
  const personParam = params.get('person');
  useEffect(() => {
    if (!personParam) return;
    setExpandedId(personParam);
    requestAnimationFrame(() => {
      document
        .getElementById(`person-${personParam}`)
        ?.scrollIntoView({ block: 'center' });
    });
  }, [personParam]);

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    if (personParam) apply({ person: null });
  };

  return (
    <div className="space-y-4">
      <AddPersonForm />

      <div className="space-y-1.5">
        {rows.length > 1 && (
          <SortBar
            className="justify-end px-1"
            options={PEOPLE_SORT_OPTIONS}
            state={sort}
            onToggle={(id) =>
              apply(sortPatch(nextSort(sort, id, PEOPLE_SORT), PEOPLE_SORT))
            }
          />
        )}
        <div className="overflow-hidden rounded-xl border bg-card">
          <ul className="divide-y">
            {/* The owner is pinned above the sort: they are the ledger's
                center, not a debtor. */}
            <OwnerLine
              owner={owner}
              owedToOwnerCents={owedToOwnerCents}
              owedByOwnerCents={owedByOwnerCents}
              debtorCount={debtorCount}
              creditorCount={creditorCount}
              open={expandedId === owner.id}
              onToggle={() => toggleExpanded(owner.id)}
            />
            {sorted.map((person) => (
              <PersonLine
                key={person.id}
                person={person}
                today={today}
                open={expandedId === person.id}
                onToggle={() => toggleExpanded(person.id)}
              />
            ))}
          </ul>
        </div>
      </div>
      {rows.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Add the people you split with, then split a transaction from the
          Expenses table.
        </p>
      )}
    </div>
  );
}

// Net bidirectional balance: positive means this person owes the owner
// (foreground), negative means the owner owes them (amber). Zero is a muted
// "Settled up". The magnitude is always shown as a positive dollar figure; the
// direction lives in the color and the accompanying label.
function NetBalance({ cents, className }: { cents: number; className?: string }) {
  if (cents === 0) {
    return (
      <span className={cn('text-muted-foreground', className)}>Settled up</span>
    );
  }
  const owesOwner = cents > 0;
  return (
    <span
      className={cn(
        'font-mono',
        owesOwner ? 'text-foreground' : 'text-amber-600 dark:text-amber-500',
        className,
      )}
      title={owesOwner ? 'They owe you' : 'You owe them'}
    >
      {formatUSD(toCents(Math.abs(cents)))}
    </span>
  );
}

function AddPersonForm() {
  const [state, formAction, pending] = useActionState(createPerson, initialPersonState);
  useReportSuccess(state);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid items-end gap-2 rounded-xl border border-dashed p-3 sm:grid-cols-[1fr_auto]"
    >
      <div className="grid gap-1">
        <Label htmlFor="add-person-name" className="text-xs text-muted-foreground">
          Name
        </Label>
        <Input id="add-person-name" name="name" placeholder="e.g. Alex" />
        {state.errors?.name && (
          <p className="text-xs text-destructive">{state.errors.name}</p>
        )}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add person'}
      </Button>
    </form>
  );
}

function OwnerLine({
  owner,
  owedToOwnerCents,
  owedByOwnerCents,
  debtorCount,
  creditorCount,
  open,
  onToggle,
}: {
  owner: PersonView;
  owedToOwnerCents: number;
  owedByOwnerCents: number;
  debtorCount: number;
  creditorCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  const nothing = owedToOwnerCents === 0 && owedByOwnerCents === 0;
  return (
    <li id={`person-${owner.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 bg-primary/5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-primary/10"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <UserRound className="size-3.5 text-primary" aria-hidden />
        </span>
        <span className="font-medium">{owner.name}</span>
        <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-primary">
          you
        </span>
        <span className="ml-auto text-right text-[11px] text-muted-foreground">
          {nothing ? (
            'All settled up'
          ) : (
            <>
              Owed{' '}
              <span className="font-mono text-foreground">
                {formatUSD(toCents(owedToOwnerCents))}
              </span>{' '}
              across {debtorCount} {debtorCount === 1 ? 'person' : 'people'}
              {owedByOwnerCents > 0 && (
                <>
                  {' · '}You owe{' '}
                  <span className="font-mono text-amber-600 dark:text-amber-500">
                    {formatUSD(toCents(owedByOwnerCents))}
                  </span>{' '}
                  across {creditorCount} {creditorCount === 1 ? 'person' : 'people'}
                </>
              )}
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t bg-muted/30 px-3 py-3">
          <RenameForm person={owner} />
        </div>
      )}
    </li>
  );
}

// Shares the picker can settle, in FIFO order. When editing a settlement,
// `freed` holds what it had applied per share: those amounts count as
// outstanding again, since saving replaces the settlement.
function pickerShares(shares: PersonShare[], freed?: Map<string, number>): OutstandingShare[] {
  return shares
    .map((s) => ({
      shareId: s.shareId,
      date: s.date,
      description: s.description,
      category: s.category,
      amountCents: s.amountCents,
      outstandingCents: s.outstandingCents + (freed?.get(s.shareId) ?? 0),
    }))
    .filter((s) => s.outstandingCents > 0);
}

// The one-line summary at the top of an expanded person: who owes whom, net.
function NetHeadline({ person, name }: { person: PersonView; name: string }) {
  if (person.netCents === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Settled up
        {(person.theyOweMeCents > 0 || person.iOweThemCents > 0) &&
          ' — everything nets out'}
      </p>
    );
  }
  const owesOwner = person.netCents > 0;
  return (
    <p className="text-[13px]">
      {owesOwner ? (
        <>
          {name} owes you{' '}
          <span className="font-mono font-medium">
            {formatUSD(toCents(person.netCents))}
          </span>
        </>
      ) : (
        <>
          You owe {name}{' '}
          <span className="font-mono font-medium text-amber-600 dark:text-amber-500">
            {formatUSD(toCents(-person.netCents))}
          </span>
        </>
      )}
      {person.theyOweMeCents > 0 && person.iOweThemCents > 0 && (
        <span className="ml-1.5 text-[11px] text-muted-foreground">
          (they owe {formatUSD(toCents(person.theyOweMeCents))}, you owe{' '}
          {formatUSD(toCents(person.iOweThemCents))})
        </span>
      )}
    </p>
  );
}

// A share, with its settlement status made visible: outstanding shows the
// amount, partial shows "outstanding $X of $Y" plus a progress bar, settled is
// muted. Incoming shares link to the source transaction; outgoing (external)
// shares carry a delete affordance instead.
function ShareRow({
  share,
  direction,
  personName,
}: {
  share: PersonShare;
  direction: 'incoming' | 'outgoing';
  personName: string;
}) {
  const body = (
    <>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {share.date}
      </span>
      <span className="min-w-0 flex-1 truncate underline-offset-2 group-hover:underline">
        {share.description}
      </span>
      {share.status === 'settled' ? (
        <span className="shrink-0 font-mono text-[11px] text-positive">settled</span>
      ) : share.status === 'partial' ? (
        <span className="shrink-0 text-right font-mono text-[11px]">
          <span className="font-medium">{formatUSD(toCents(share.outstandingCents))}</span>
          <span className="text-muted-foreground"> of {formatUSD(toCents(share.amountCents))}</span>
        </span>
      ) : (
        <span className="shrink-0 font-mono">{formatUSD(toCents(share.amountCents))}</span>
      )}
    </>
  );

  return (
    <li>
      <div className="flex items-baseline gap-2 text-xs">
        <ShareDetailDialog
          share={share}
          personName={personName}
          direction={direction}
          trigger={
            <button
              type="button"
              className="group flex flex-1 items-baseline gap-2 rounded text-left transition-colors hover:bg-muted/60"
            >
              {body}
            </button>
          }
        />
      </div>
      {share.status === 'partial' && (
        <div className="ml-[3.25rem] mt-0.5 h-1 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-positive"
            style={{
              width: `${Math.round((share.allocatedCents / Math.max(1, share.amountCents)) * 100)}%`,
            }}
          />
        </div>
      )}
    </li>
  );
}

// Rows for one list of shares, as headed category groups when that is the
// active sort and a flat list otherwise. Without the headings a category sort
// reads as an unexplained reshuffle: the rows move but nothing on screen says
// why, and the shared text (which does carry headings) stops matching.
function ShareRows({
  shares,
  direction,
  personName,
  grouped,
}: {
  shares: PersonShare[];
  direction: 'incoming' | 'outgoing';
  personName: string;
  grouped: boolean;
}) {
  const row = (s: PersonShare) =>
    direction === 'outgoing' ? (
      <OutgoingShareRow key={s.shareId} share={s} personName={personName} />
    ) : (
      <ShareRow
        key={s.shareId}
        share={s}
        direction={direction}
        personName={personName}
      />
    );

  if (!grouped) return <ul className="space-y-1">{shares.map(row)}</ul>;

  // Groups follow the sorted order rather than being re-sorted, so the
  // headings track whichever direction the category sort is pointing.
  const order: string[] = [];
  const byCategory = new Map<string, PersonShare[]>();
  for (const s of shares) {
    const key = s.category ?? 'Uncategorized';
    if (!byCategory.has(key)) {
      byCategory.set(key, []);
      order.push(key);
    }
    byCategory.get(key)!.push(s);
  }

  return (
    <div className="space-y-2">
      {order.map((key) => {
        const group = byCategory.get(key)!;
        const subtotal = group.reduce((acc, s) => acc + s.outstandingCents, 0);
        return (
          <div key={key}>
            <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wider">{key}</span>
              <span className="font-mono">{formatUSD(toCents(subtotal))}</span>
            </div>
            <ul className="space-y-1">{group.map(row)}</ul>
          </div>
        );
      })}
    </div>
  );
}

// Outstanding shares (visible) plus a collapsed "Show N settled" reveal.
function DirectionSectionBody({
  shares,
  direction,
  personName,
  sort,
}: {
  shares: PersonShare[];
  direction: 'incoming' | 'outgoing';
  personName: string;
  // Owned by PersonLine so both directions sort together and the shared
  // message can be built from the same order the reader is looking at.
  sort: SortState;
}) {
  const [showSettled, setShowSettled] = useState(false);
  // Sort outstanding and settled independently so the settled reveal follows
  // the same order without settled rows displacing live ones.
  const outstanding = sortShares(shares.filter((s) => s.status !== 'settled'), sort);
  const settled = sortShares(shares.filter((s) => s.status === 'settled'), sort);
  const grouped = sort.sort === 'category';
  return (
    <div className="space-y-1.5">
      {outstanding.length > 0 ? (
        <ShareRows
          shares={outstanding}
          direction={direction}
          personName={personName}
          grouped={grouped}
        />
      ) : (
        <p className="text-xs text-muted-foreground">All settled.</p>
      )}
      {settled.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSettled((v) => !v)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {showSettled ? 'Hide' : 'Show'} {settled.length} settled
          </button>
          {showSettled && (
            <div className="mt-1 opacity-70">
              <ShareRows
                shares={settled}
                direction={direction}
                personName={personName}
                grouped={grouped}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A titled direction section (used for "They owe you").
function DirectionSection({
  title,
  shares,
  direction,
  personName,
  sort,
}: {
  title: string;
  shares: PersonShare[];
  direction: 'incoming' | 'outgoing';
  personName: string;
  sort: SortState;
}) {
  return (
    <section className="border-t border-dashed pt-2.5">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <DirectionSectionBody
        shares={shares}
        direction={direction}
        personName={personName}
        sort={sort}
      />
    </section>
  );
}

// An outgoing (external) share row with a delete affordance — no bank
// transaction to soft-delete through, so it hard-deletes the split here.
function OutgoingShareRow({
  share,
  personName,
}: {
  share: PersonShare;
  personName: string;
}) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <ShareDetailDialog
        share={share}
        personName={personName}
        direction="outgoing"
        trigger={
          <button
            type="button"
            className="group flex flex-1 items-baseline gap-2 rounded text-left transition-colors hover:bg-muted/60"
          >
            <ShareRowInline share={share} />
          </button>
        }
      />
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 shrink-0 text-muted-foreground/50 hover:text-destructive"
            aria-label={`Delete expense "${share.description}" for ${formatUSD(toCents(share.amountCents))}`}
          >
            <Trash2 className="size-3" />
          </Button>
        }
        title="Delete this expense?"
        description={
          <>
            The {formatUSD(toCents(share.amountCents))} expense &ldquo;
            {share.description}&rdquo; you owe {personName} is removed, and any
            settlement credit applied to it returns to that payment&rsquo;s
            unallocated pool.
          </>
        }
        confirmLabel="Delete expense"
        pendingLabel="Deleting…"
        onConfirm={() => deleteExternalExpense(share.splitId)}
      />
    </li>
  );
}

// The date/description/status content shared by the outgoing row (which adds a
// delete button beside it).
function ShareRowInline({ share }: { share: PersonShare }) {
  return (
    <span className="flex flex-1 items-baseline gap-2">
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {share.date}
      </span>
      <span className="min-w-0 flex-1 truncate underline-offset-2 group-hover:underline">
        {share.description}
      </span>
      {share.status === 'settled' ? (
        <span className="shrink-0 font-mono text-[11px] text-positive">settled</span>
      ) : share.status === 'partial' ? (
        <span className="shrink-0 text-right font-mono text-[11px]">
          <span className="font-medium">{formatUSD(toCents(share.outstandingCents))}</span>
          <span className="text-muted-foreground"> of {formatUSD(toCents(share.amountCents))}</span>
        </span>
      ) : (
        <span className="shrink-0 font-mono">{formatUSD(toCents(share.amountCents))}</span>
      )}
    </span>
  );
}

// A payment row: what moved (or "offset" when nothing did), any offset that
// cleared both sides, edit and delete, and an expandable breakdown of the
// shares it settled plus leftover credit.
function SettlementRow({
  settlement,
  personName,
  onEdit,
}: {
  settlement: PersonSettlement;
  personName: string;
  onEdit: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const { cash, offsetCents } = settlement;
  const credit = cash?.unallocatedCents ?? 0;
  const detailCount = settlement.allocations.length + (credit > 0 ? 1 : 0);
  const badge = !cash ? 'offset' : cash.direction === 'incoming' ? 'they paid' : 'you paid';
  const paid = settlement.allocations.filter((a) => !a.offset);
  const offsetTheirs = settlement.allocations.filter((a) => a.offset && a.direction === 'incoming');
  const offsetYours = settlement.allocations.filter((a) => a.offset && a.direction === 'outgoing');
  const what = cash
    ? `${formatUSD(toCents(cash.amountCents))} ${
        cash.direction === 'incoming' ? `payment from ${personName}` : `payment to ${personName}`
      }`
    : `${formatUSD(toCents(offsetCents))} offset with ${personName}`;
  return (
    <li className="text-xs">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {settlement.date}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={detailCount === 0}
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            detailCount > 0 && 'underline-offset-2 hover:underline',
          )}
        >
          <span className="rounded border px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {badge}
          </span>{' '}
          {settlement.note ?? (cash ? 'Payment' : 'Offset')}
        </button>
        {cash && offsetCents > 0 && (
          <span
            className="shrink-0 font-mono text-[11px] text-muted-foreground"
            title="Cleared from both sides without money changing hands"
          >
            + {formatUSD(toCents(offsetCents))} offset
          </span>
        )}
        <span
          className={cn(
            'shrink-0 font-mono',
            !cash
              ? 'text-muted-foreground'
              : cash.direction === 'incoming'
                ? 'text-positive'
                : 'text-amber-600 dark:text-amber-500',
          )}
        >
          {formatUSD(toCents(cash ? cash.amountCents : offsetCents))}
        </span>
        {onEdit && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 shrink-0 text-muted-foreground/50 hover:text-foreground"
            aria-label={`Edit ${what} from ${settlement.date}`}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
          </Button>
        )}
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 shrink-0 text-muted-foreground/50 hover:text-destructive"
              aria-label={`Delete ${what} from ${settlement.date}`}
            >
              <Trash2 className="size-3" />
            </Button>
          }
          title="Delete this settlement?"
          description={
            <>
              The {what}
              {cash && offsetCents > 0 && ` and its ${formatUSD(toCents(offsetCents))} offset`} on{' '}
              {settlement.date} {cash && offsetCents > 0 ? 'are' : 'is'} removed; the shares it
              settled reopen and the balance recomputes without it.
            </>
          }
          confirmLabel="Delete settlement"
          pendingLabel="Deleting…"
          onConfirm={() => deleteSettlement(settlement.id)}
        />
      </div>
      {open && detailCount > 0 && (
        <div className="ml-[3.25rem] mt-0.5 space-y-1 text-[11px] text-muted-foreground">
          <AllocationLines lines={paid} />
          {offsetTheirs.length + offsetYours.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wider text-[10px]">
                Offset — cleared both ways
              </p>
              <AllocationLines lines={offsetTheirs} label={`from what ${personName} owed`} />
              <AllocationLines lines={offsetYours} label="from what you owed" />
            </div>
          )}
          {credit > 0 && (
            <p className="flex items-baseline gap-2 italic">
              <span className="min-w-0 flex-1 truncate">Unapplied credit (carries forward)</span>
              <span className="shrink-0 font-mono">{formatUSD(toCents(credit))}</span>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function AllocationLines({
  lines,
  label,
}: {
  lines: PersonSettlement['allocations'];
  label?: string;
}) {
  if (lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <ul className="space-y-0.5">
      {label && <li className="italic">{label}</li>}
      {sorted.map((a, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{a.description}</span>
          <span className="shrink-0 font-mono">{formatUSD(toCents(a.amountCents))}</span>
        </li>
      ))}
    </ul>
  );
}

function PersonLine({
  person,
  today,
  open,
  onToggle,
}: {
  person: PersonView;
  today: string;
  open: boolean;
  onToggle: () => void;
}) {
  const displayName = person.deleted ? '(deleted person)' : person.name;
  const shareCount = person.incoming.length + person.outgoing.length;
  // One sort for both directions, so the two lists read consistently and the
  // shared message can be built from the order actually on screen.
  const [sort, setSort] = useState<SortState>({
    sort: SHARE_SORT.defaultSort,
    dir: SHARE_SORT.defaultDir,
  });
  // Only outstanding rows are worth sending; settled ones are history.
  const outstandingIncoming = sortShares(
    person.incoming.filter((s) => s.status !== 'settled'),
    sort,
  );
  const outstandingOutgoing = sortShares(
    person.outgoing.filter((s) => s.status !== 'settled'),
    sort,
  );

  // The share picker, opened by "Pick shares…" and "Settle up" on the inline
  // form and by Edit on a settlement. The inline form remounts after a picker
  // save (formKey) so its fields clear.
  const [picker, setPicker] = useState<{ start: PickerStart; freed: Map<string, number> }>({
    start: {
      replaceId: null,
      direction: 'incoming',
      date: today,
      note: '',
      amountText: '',
      preselect: null,
      selection: null,
      pinnedCashText: null,
    },
    freed: new Map(),
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const openPicker = (start: PickerStart, freed = new Map<string, number>()) => {
    setPicker({ start, freed });
    setPickerOpen(true);
  };
  const onPickerRecorded = useCallback(() => {
    setPickerOpen(false);
    setFormKey((k) => k + 1);
  }, []);
  const editSettlement = (st: PersonSettlement) => {
    const applied = new Map<string, number>();
    for (const a of st.allocations) {
      applied.set(a.shareId, (applied.get(a.shareId) ?? 0) + a.amountCents);
    }
    openPicker(
      {
        replaceId: st.id,
        direction: st.cash?.direction ?? 'incoming',
        date: st.date,
        note: st.note ?? '',
        amountText: '',
        preselect: null,
        selection: Object.fromEntries(applied),
        // Cash that exactly covered its shares follows the selection, so
        // adding the other side nets it down; cash that left credit is kept.
        pinnedCashText:
          st.cash && st.cash.unallocatedCents > 0
            ? formatCents(toCents(st.cash.amountCents))
            : null,
      },
      applied,
    );
  };

  return (
    <li id={`person-${person.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
          <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
        </span>
        <span className={cn('font-medium', person.deleted && 'italic text-muted-foreground')}>
          {displayName}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {shareCount} share{shareCount === 1 ? '' : 's'}
          {person.settlements.length > 0 &&
            ` · ${person.settlements.length} settlement${
              person.settlements.length === 1 ? '' : 's'
            }`}
        </span>
        <NetBalance cents={person.netCents} className="ml-auto" />
      </button>

      {open && (
        <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
          <NetHeadline person={person} name={displayName} />

          {/* One control row for the whole person: the sort applies to both
              directions, and Share sends both sides plus the net. */}
          {shareCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {shareCount > 1 ? (
                <SortBar
                  options={SHARE_SORT_OPTIONS}
                  state={sort}
                  onToggle={(id) => setSort((c) => nextSort(c, id, SHARE_SORT))}
                />
              ) : (
                <span />
              )}
              <ShareListButton
                className="h-6 px-1.5 text-[11px]"
                personName={person.deleted ? person.name : displayName}
                owed={toShareLines(outstandingIncoming)}
                owing={toShareLines(outstandingOutgoing)}
                groupBy={sort.sort === 'category' ? 'category' : null}
              />
            </div>
          )}

          {/* They owe you (incoming). */}
          {person.incoming.length > 0 && (
            <DirectionSection
              title="They owe you"
              shares={person.incoming}
              direction="incoming"
              personName={displayName}
              sort={sort}
            />
          )}

          {/* You owe them (outgoing external splits). Always shown for an
              active person so the log button is reachable even at $0. */}
          {!person.deleted && (
            <section className="border-t border-dashed pt-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  You owe them
                </h3>
                <ExternalExpenseDialog
                  personId={person.id}
                  personName={person.name}
                  today={today}
                  trigger={
                    <Button type="button" variant="outline" size="sm" className="h-7">
                      <HandCoins data-icon="inline-start" />
                      Log expense you paid
                    </Button>
                  }
                />
              </div>
              {person.outgoing.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing you owe {person.name} yet.
                </p>
              ) : (
                <DirectionSectionBody
                  shares={person.outgoing}
                  direction="outgoing"
                  personName={displayName}
                  sort={sort}
                />
              )}
            </section>
          )}

          {/* Settlements + record form. */}
          <section className="border-t border-dashed pt-2.5">
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Settlements
            </h3>
            {person.settlements.length === 0 ? (
              <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {person.settlements.map((s) => (
                  <SettlementRow
                    key={s.id}
                    settlement={s}
                    personName={displayName}
                    onEdit={person.deleted ? null : () => editSettlement(s)}
                  />
                ))}
              </ul>
            )}
            <AddSettlementForm
              key={formKey}
              personId={person.id}
              personName={displayName}
              today={today}
              incoming={pickerShares(person.incoming)}
              outgoing={pickerShares(person.outgoing)}
              onPick={openPicker}
            />
            <SettleAllocatorDialog
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              personId={person.id}
              personName={displayName}
              incoming={pickerShares(person.incoming, picker.freed)}
              outgoing={pickerShares(person.outgoing, picker.freed)}
              start={picker.start}
              onRecorded={onPickerRecorded}
            />
          </section>

          {!person.deleted ? (
            <div className="flex items-end justify-between gap-2 border-t border-dashed pt-2.5">
              <RenameForm person={person} />
              {/* Soft delete — the person keeps their share history. */}
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${person.name}`}
                  >
                    <Trash2 />
                  </Button>
                }
                title={`Delete ${person.name}?`}
                description="They disappear from new splits and settlements but keep their history, and stay listed here while any shares or settlements remain."
                confirmLabel="Delete person"
                pendingLabel="Deleting…"
                onConfirm={async () => {
                  const fd = new FormData();
                  fd.set('id', person.id);
                  return deletePerson(fd);
                }}
              />
            </div>
          ) : (
            // A soft-deleted person lingers here only for leftover activity.
            // Offer a permanent delete once no active shares remain (only
            // settlements keeping them visible), so it can never strip
            // someone out of a live split.
            canHardDeletePerson({
              deleted: person.deleted,
              shareCount,
              settlementCount: person.settlements.length,
            }) && (
              <div className="flex items-center justify-between gap-2 border-t border-dashed pt-2.5">
                <p className="text-[11px] text-muted-foreground">
                  Removed — kept only to clear leftover settlements.
                </p>
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete permanently
                    </Button>
                  }
                  title="Delete this person permanently?"
                  description="This person and all of their settlements are erased for good. This cannot be undone."
                  confirmLabel="Delete permanently"
                  pendingLabel="Deleting…"
                  onConfirm={() => hardDeletePerson(person.id)}
                />
              </div>
            )
          )}
        </div>
      )}
    </li>
  );
}

function RenameForm({ person }: { person: PersonView }) {
  const [state, formAction, pending] = useActionState(renamePerson, initialPersonState);

  return (
    <form action={formAction} className="flex items-end gap-2">
      <input type="hidden" name="id" value={person.id} />
      <div className="grid gap-1">
        <Label
          htmlFor={`person-name-${person.id}`}
          className="text-[11px] text-muted-foreground"
        >
          Name
        </Label>
        <Input
          id={`person-name-${person.id}`}
          name="name"
          defaultValue={person.name}
          className="h-7 w-44 text-xs"
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="h-7">
        {pending ? 'Saving…' : 'Rename'}
      </Button>
      {state.errors?.name && (
        <p className="self-center text-xs text-destructive">{state.errors.name}</p>
      )}
    </form>
  );
}

function AddSettlementForm({
  personId,
  personName,
  today,
  incoming,
  outgoing,
  onPick,
}: {
  personId: string;
  personName: string;
  today: string;
  incoming: OutstandingShare[];
  outgoing: OutstandingShare[];
  onPick: (start: PickerStart) => void;
}) {
  const [state, formAction, pending] = useActionState(
    createSettlement,
    initialSettlementState,
  );
  useReportSuccess(state);
  const formRef = useRef<HTMLFormElement>(null);
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [amountText, setAmountText] = useState('');
  const targetShares = direction === 'incoming' ? incoming : outgoing;
  const fullBalanceCents = totalOutstanding(targetShares);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setAmountText('');
      setDirection('incoming');
    }
  }, [state]);

  // Picker hand-off, carrying whatever the inline fields hold.
  const pick = (preselect: 'all' | null) => {
    const field = (name: string) =>
      (formRef.current?.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '';
    onPick({
      replaceId: null,
      direction,
      date: field('date') || today,
      note: field('note'),
      amountText: preselect ? '' : amountText,
      preselect,
      selection: null,
      pinnedCashText: null,
    });
  };

  // Owing each other: the honest "everything" is the net, settled by netting
  // both sides in the picker. Filling Amount with one side's total would
  // FIFO-clear that side alone and leave the other open.
  const owesBothWays = incoming.length > 0 && outgoing.length > 0;
  const netCents = totalOutstanding(incoming) - totalOutstanding(outgoing);

  const dirLabel = direction === 'incoming' ? `${personName} paid you` : `you paid ${personName}`;

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-3 grid gap-2 rounded-lg border border-dashed p-2"
    >
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="direction" value={direction} />

      {/* Direction toggle: they paid me (default) vs. I paid them. */}
      <div
        role="radiogroup"
        aria-label="Settlement direction"
        className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5"
      >
        {(
          [
            ['incoming', 'They paid me'],
            ['outgoing', 'I paid them'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={direction === value}
            onClick={() => setDirection(value)}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors',
              direction === value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid items-end gap-2 sm:grid-cols-[6rem_8.75rem_1fr_auto]">
        <div className="grid gap-1">
          <Label
            htmlFor={`settle-amount-${personId}`}
            className="text-[11px] text-muted-foreground"
          >
            Amount
          </Label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
              $
            </span>
            <Input
              id={`settle-amount-${personId}`}
              name="amount"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="0.00"
              className="h-7 pl-5 text-right font-mono text-xs"
            />
          </div>
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`settle-date-${personId}`}
            className="text-[11px] text-muted-foreground"
          >
            Date
          </Label>
          <Input
            id={`settle-date-${personId}`}
            name="date"
            type="date"
            defaultValue={today}
            className="h-7 font-mono text-xs"
          />
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`settle-note-${personId}`}
            className="text-[11px] text-muted-foreground"
          >
            Note
          </Label>
          <Input
            id={`settle-note-${personId}`}
            name="note"
            placeholder="optional"
            className="h-7 text-xs"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending} className="h-7">
          <HandCoins data-icon="inline-start" />
          {pending ? 'Recording…' : 'Record'}
        </Button>
      </div>

      {/* Manual allocation lives in a dialog: the inline column is too narrow
          for a share table, and the payment otherwise fills oldest-first. */}
      {(targetShares.length > 0 || owesBothWays) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>Fills oldest shares first.</span>
          {owesBothWays ? (
            <button
              type="button"
              onClick={() => pick('all')}
              title="Offsets what you owe them against what they owe you; only the difference is recorded as money paid"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-px font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/10"
            >
              {netCents === 0
                ? 'Net off both sides'
                : netCents > 0
                  ? `Settle up · ${personName} pays`
                  : 'Settle up · you pay'}
              {netCents !== 0 && (
                <span className="font-mono tabular-nums">
                  {formatUSD(toCents(Math.abs(netCents)))}
                </span>
              )}
            </button>
          ) : (
            /* Input shortcut only: fills Amount with everything outstanding
               in this direction, which FIFO then settles in full. */
            <button
              type="button"
              onClick={() => setAmountText(formatCents(toCents(fullBalanceCents)))}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-px font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/10"
            >
              Full balance
              <span className="font-mono tabular-nums">{formatUSD(toCents(fullBalanceCents))}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => pick(null)}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            <ListChecks className="size-3" aria-hidden />
            Pick shares…
          </button>
        </div>
      )}

      {(state.errors?.amount || state.errors?.date || state.errors?.note) && (
        <p className="text-xs text-destructive">
          {state.errors.amount ?? state.errors.date ?? state.errors.note}
        </p>
      )}
      <p className="sr-only">Record a settlement — {dirLabel}</p>
    </form>
  );
}
