import { Suspense } from 'react';
import {
  getAllPersons,
  getDebtShares,
  getSettlements,
  getSettlementAllocationDetails,
} from '@/db/queries';
import { computeBidirectionalBalances } from '@/lib/balances';
import { shareStatus } from '@/lib/allocations';
import { isPersonVisible } from '@/lib/people-visibility';
import { buildSimplifyView } from '@/lib/simplify-view';
import { toCents, formatUSD } from '@/lib/money';
import {
  PeopleList,
  type PersonSettlement,
  type PersonShare,
  type PersonView,
} from '@/app/_components/people-list';
import { SimplifyCard } from '@/app/_components/simplify-card';
import { requireUser } from '@/app/_lib/session';

export const metadata = { title: 'People · tally' };

// Rendered per request: the settlement forms default to today's date, which
// a page prerendered at build and refreshed only by revalidatePath would
// freeze at the last change to the ledger.
export const dynamic = 'force-dynamic';

// People and Balances merged (phase 6): one page holds who you split with and
// what each person owes, with per-person history under each row. Balances are
// bidirectional (batch B): net = what a person owes the owner minus what the
// owner owes them, share by share, minus settlement allocations.
export default async function PeoplePage() {
  await requireUser();
  const [persons, debtShares, settlements, allocationDetails] = await Promise.all([
    getAllPersons(),
    getDebtShares(),
    getSettlements(),
    getSettlementAllocationDetails(),
  ]);

  const balances = new Map(
    computeBidirectionalBalances(
      debtShares.map((s) => ({
        shareId: s.shareId,
        counterpartyId: s.counterpartyId,
        direction: s.direction,
        amountCents: toCents(s.amountCents),
        allocatedCents: toCents(s.allocatedCents),
      })),
    ).map((b) => [b.personId, b]),
  );

  const allocationsBySettlement = new Map<string, typeof allocationDetails>();
  for (const a of allocationDetails) {
    const list = allocationsBySettlement.get(a.settlementId) ?? [];
    list.push(a);
    allocationsBySettlement.set(a.settlementId, list);
  }

  // One entry per payment: a netted group (cash + offset pair) collapses into
  // a single row, a plain settlement is a group of one. Rows arrive newest
  // first, so first appearance keeps that order.
  const settlementGroups = new Map<string, PersonSettlement & { personId: string }>();
  for (const s of settlements) {
    const key = s.groupId ?? s.id;
    let g = settlementGroups.get(key);
    if (!g) {
      g = {
        id: s.id,
        personId: s.personId,
        date: s.date,
        note: s.note,
        cash: null,
        offsetCents: 0,
        allocations: [],
      };
      settlementGroups.set(key, g);
    }
    if (s.isOffset) {
      // The two halves are equal; count the pair once.
      if (s.direction === 'incoming') g.offsetCents = s.amountCents;
    } else {
      g.cash = {
        direction: s.direction,
        amountCents: s.amountCents,
        unallocatedCents: s.unallocatedCents,
      };
    }
    for (const a of allocationsBySettlement.get(s.id) ?? []) {
      g.allocations.push({
        shareId: a.splitShareId,
        direction: s.direction,
        offset: s.isOffset,
        description: a.shareDescription,
        date: a.shareDate,
        amountCents: a.amountCents,
      });
    }
  }
  const groupsByPerson = new Map<string, PersonSettlement[]>();
  for (const { personId, ...g } of settlementGroups.values()) {
    const list = groupsByPerson.get(personId) ?? [];
    list.push(g);
    groupsByPerson.set(personId, list);
  }

  const toShare = (s: (typeof debtShares)[number]): PersonShare => {
    const st = shareStatus(s);
    return {
      shareId: s.shareId,
      splitId: s.splitId,
      transactionId: s.transactionId,
      date: s.date,
      description: s.description,
      amountCents: s.amountCents,
      allocatedCents: s.allocatedCents,
      outstandingCents: st.outstandingCents,
      status: st.status,
      category: s.categoryName,
      transactionAmountCents: s.transactionAmountCents,
      note: s.note,
      merchantLabel: s.merchantLabel,
      method: s.method,
      participantCount: s.participantCount,
    };
  };

  const toView = (p: (typeof persons)[number]): PersonView => {
    const b = balances.get(p.id);
    const personShares = debtShares.filter((s) => s.counterpartyId === p.id);
    return {
      id: p.id,
      name: p.name,
      isOwner: p.isOwner,
      deleted: p.deleted,
      addedOn: p.createdAt.toISOString().slice(0, 10),
      theyOweMeCents: b?.theyOweMeCents ?? 0,
      iOweThemCents: b?.iOweThemCents ?? 0,
      netCents: b?.netCents ?? 0,
      incoming: personShares.filter((s) => s.direction === 'incoming').map(toShare),
      outgoing: personShares.filter((s) => s.direction === 'outgoing').map(toShare),
      settlements: groupsByPerson.get(p.id) ?? [],
    };
  };

  const owner = persons.find((p) => p.isOwner);
  // Active non-owner people always appear (a fresh person shows $0.00);
  // soft-deleted people linger only while they still carry activity — any
  // remaining share or settlement. A deleted person whose transactions were
  // all removed and whose settlements were all deleted drops off entirely.
  const rows = persons
    .filter((p) => !p.isOwner)
    .map(toView)
    .filter((p) =>
      isPersonVisible({
        deleted: p.deleted,
        shareCount: p.incoming.length + p.outgoing.length,
        settlementCount: p.settlements.length,
      }),
    );

  // Owner summary: total the owner is owed (across people with a positive net)
  // and total the owner owes (across people with a negative net).
  const owedToOwner = rows.reduce((acc, r) => acc + Math.max(0, r.netCents), 0);
  const owedByOwner = rows.reduce((acc, r) => acc + Math.max(0, -r.netCents), 0);
  const debtorCount = rows.filter((r) => r.netCents > 0).length;
  const creditorCount = rows.filter((r) => r.netCents < 0).length;
  const today = new Date().toISOString().slice(0, 10);

  // Debt simplification over everyone shown. A suggestion only; hidden when
  // nothing is owed in either direction.
  const simplify = owner
    ? buildSimplifyView({
        ownerId: owner.id,
        people: rows.map((r) => ({ personId: r.id, netCents: r.netCents })),
        shares: debtShares.map((s) => ({
          counterpartyId: s.counterpartyId,
          outstandingCents: shareStatus(s).outstandingCents,
        })),
      })
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">People</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {rows.length === 0
            ? 'Just you so far — add the people you split with'
            : `You and ${rows.length} ${
                rows.length === 1 ? 'person' : 'people'
              } · ${formatUSD(toCents(owedToOwner))} owed to you`}
        </p>
      </div>
      {owner && simplify && simplify.perPersonPayments.length > 0 && (
        <SimplifyCard
          view={simplify}
          names={Object.fromEntries(rows.map((r) => [r.id, r.name]))}
          ownerId={owner.id}
        />
      )}
      {owner ? (
        // useTableState reads useSearchParams, which needs a Suspense
        // boundary to prerender; params resolve client-side on hydration.
        <Suspense>
          <PeopleList
            owner={toView(owner)}
            rows={rows}
            owedToOwnerCents={owedToOwner}
            owedByOwnerCents={owedByOwner}
            debtorCount={debtorCount}
            creditorCount={creditorCount}
            today={today}
          />
        </Suspense>
      ) : (
        <p className="rounded-xl border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          No owner person found — reseed the database.
        </p>
      )}
    </main>
  );
}
