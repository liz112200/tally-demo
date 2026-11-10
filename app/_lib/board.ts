import 'server-only';
import { getBankConnections, SYNCABLE_ACCOUNT_TYPES } from '@/db/queries';
import { ledgerStateFor } from '@/db/ledger';
import { loadLedgerView } from '@/app/_lib/ledger-view';
import { filterByTab, needsReview } from '@/lib/expense-filters';
import { accountCard, isUnverified } from '@/lib/account-card';
import { formatUSD, toCents } from '@/lib/money';
import type { BoardCard } from '@/app/_components/account-board';
import { ledgerFacts } from '@/lib/needs-you-facts';
import { reviewApplies } from '@/lib/review';
import type { NeedsYouFacts } from '@/lib/needs-you';
import { classifyItemError, consentState, healthSentence } from '@/lib/bank-sync/item-health';
import { staleLines } from '@/lib/bank-sync/staleness';
import { isDemoMode } from '@/lib/demo-mode';

const SYNCABLE = new Set<string>(SYNCABLE_ACCOUNT_TYPES);

const shortDay = (iso: string, today: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });

// What the accounts board shows (2026-11-05), and what the Needs you band is
// worked out from: every ledger account as a card, every linked account not
// yet set up, and each ledger account's bank accounts with their state.
export async function loadBoard() {
  const today = new Date().toISOString().slice(0, 10);
  const day = (iso: string) => shortDay(iso, today);
  const [view, connections] = await Promise.all([loadLedgerView(), getBankConnections()]);
  const live = connections.filter((c) => c.status !== 'removed');
  const banks = live.flatMap((c) => c.accounts.map((a) => ({ ...a, connection: c })));
  const states = await ledgerStateFor(banks.map((b) => b.id));

  // A ledger account's bank accounts, each with its state: rows that need
  // verifying, rows held for an answer.
  const banksOf = (ledgerId: string) =>
    banks
      .map((b) => ({ bank: b, state: states.get(b.id) }))
      .filter((x) => x.state?.ledgerAccountId === ledgerId);

  const cards: BoardCard[] = view.ledgers.map((ledger) => {
    const mine = banksOf(ledger.id);
    const rows = filterByTab(view.transactions, { kind: 'ledger', id: ledger.id });
    const syncedAt = mine
      .map((x) => x.bank.lastSyncedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const lastImport = view.importGroups
      .filter((i) => i.ledgerAccountId === ledger.id)
      .map((i) => i.importedAt)
      .sort()
      .reverse()[0];
    return {
      ...accountCard({
        ledger,
        rows,
        reviewed: (closingDate, diff) => reviewApplies(view.statementReviews[`${ledger.id}:${closingDate}`], diff),
        linked: mine.length > 0,
        held: mine.reduce((n, x) => n + (x.state?.heldCount ?? 0), 0),
        unverified: mine.some((x) => isUnverified(x.bank, x.state)),
        today,
        formatDay: day,
        formatMoney: (n) => formatUSD(toCents(n)),
      }),
      syncedAt: syncedAt ? syncedAt.toISOString() : null,
      lastImport: lastImport ? day(lastImport) : null,
    };
  });

  // Linked accounts that could sync but have no ledger account yet.
  const unmapped = banks
    .filter((b) => SYNCABLE.has(b.type) && !b.unsharedAt && !states.get(b.id)?.ledgerAccountId && !states.get(b.id)?.replacesAccountId)
    .map((b) => ({ id: b.id, name: b.mask ? `${b.name} ••${b.mask}` : b.name }));

  return { today, view, banks, states, banksOf, cards, unmapped, loginCount: live.length };
}

type Board = Awaited<ReturnType<typeof loadBoard>>;

// What the Needs you band is worked out from (lib/needs-you.ts): the facts
// only, each of which the data shows is still open.
export function needsYouFacts(board: Board): NeedsYouFacts {
  const { view, banks, states, today } = board;
  const now = new Date();
  const facts: NeedsYouFacts = {
    held: [],
    disagreements: [],
    logins: [],
    unverified: [],
    withoutTotals: [],
    missingStatements: [],
    noStatements: [],
    flaggedRows: view.transactions.filter((t) => needsReview(t)).length,
    // Only those the conversion would accept: a line nobody can resolve
    // would sit there for good.
    // Kept raised (a review that still applies) is decided, not open.
    raisedRows: Object.entries(view.conversions).filter(([id, refusal]) => refusal === null && !(id in view.keptRaised)).length,
    pointOut: view.pointOut.map((p) => ({ ruleId: p.ruleId, pattern: p.pattern, categoryName: p.categoryName, count: p.rowIds.length })),
  };
  for (const ledger of view.ledgers) {
    const mine = board.banksOf(ledger.id);
    const held = mine.reduce((n, x) => n + (x.state?.heldCount ?? 0), 0);
    if (held > 0) facts.held.push({ ledgerId: ledger.id, name: ledger.label, count: held });
    const f = ledgerFacts({ ledger, rows: filterByTab(view.transactions, { kind: 'ledger', id: ledger.id }), today });
    // A difference a review accepted, as it now is, is not raised; one whose
    // figures moved since is (reviewApplies).
    facts.disagreements.push(
      ...f.disagreements.filter(
        (d) =>
          !reviewApplies(view.statementReviews[`${ledger.id}:${d.closingDate}`], {
            chargesDiff: (d.charges?.listedCents ?? 0) - (d.charges?.statedCents ?? 0),
            creditsDiff: (d.credits?.listedCents ?? 0) - (d.credits?.statedCents ?? 0),
          }),
      ),
    );
    facts.withoutTotals.push(...f.withoutTotals);
    facts.missingStatements.push(...f.missingStatements);
    facts.noStatements.push(...f.noStatements);
    for (const x of mine) {
      if (!isUnverified(x.bank, x.state)) continue;
      facts.unverified.push({ bankAccountId: x.bank.id, name: mine.length > 1 && x.bank.mask ? `${ledger.label} ••${x.bank.mask}` : ledger.label });
    }
  }
  // A login that needs the owner, as soon as it does: the same sentence its
  // Bank logins card shows. Then accounts on a healthy login whose daily sync
  // has not run (36 hours, SCHEDULED-SYNC.md). A sync that failed on a healthy
  // login is not raised: the next daily sync retries it, nothing to do yet.
  const needingOwner = new Set<string>();
  for (const c of new Map(banks.map((b) => [b.connection.id, b.connection])).values()) {
    if (c.status !== 'active') continue;
    const kind = classifyItemError(c.itemErrorCode);
    const institution = c.institutionName ?? 'This bank';
    const consentEnded = kind !== 'gone' && consentState(c.consentExpiresAt, now) === 'expired';
    if (kind === 'healthy' || kind === 'bank_unavailable') {
      if (!consentEnded) continue;
    }
    needingOwner.add(c.id);
    facts.logins.push({
      key: c.id,
      subject: institution,
      text:
        kind === 'healthy' || kind === 'bank_unavailable'
          ? "ended this login's consent; Reconnect renews it, with no new Item."
          : (healthSentence(c.itemErrorCode, institution) ?? 'needs you on Bank logins.'),
      action: kind === 'gone' ? 'Open' : 'Reconnect',
      href: '/accounts/logins',
    });
  }
  if (!isDemoMode()) {
    const quiet = staleLines(
      banks
        .filter((b) => !needingOwner.has(b.connection.id))
        .map((b) => ({
          label: states.get(b.id)?.ledgerName ?? (b.mask ? `${b.name} ••${b.mask}` : b.name),
          institution: b.connection.institutionName ?? 'The bank',
          connectionStatus: b.connection.status,
          itemErrorCode: b.connection.itemErrorCode,
          consentExpiresAt: b.connection.consentExpiresAt,
          syncEnabled: b.syncEnabled,
          unshared: b.unsharedAt !== null,
          lastSyncedAt: b.lastSyncedAt,
          lastSyncError: b.lastSyncError,
        })),
      now,
    );
    for (const line of quiet.filter((l) => l.kind === 'not_run')) {
      facts.logins.push({ key: `stale:${line.label}`, subject: line.label, text: line.text.slice(line.label.length + 1), action: 'Open', href: '/accounts/logins' });
    }
  }
  return facts;
}
