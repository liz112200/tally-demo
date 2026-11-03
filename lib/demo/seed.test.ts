import { describe, it, expect } from 'vitest';
import { buildDemoSeed, seedDayFromOwnerCreatedAt, type DemoSeed } from './seed';
import { computeBidirectionalBalances, type DebtShare } from '../balances';
import { buildSimplifyView } from '../simplify-view';
import { detectParser } from '../parsers/detect';
import { toCents } from '../money';
import { compareToStatement } from '../bank-sync/verify';
import { dedupHash } from '../parsers/dedup';

// Balances and the simplification view exactly as /people derives them.
function derive(seed: DemoSeed) {
  const split = new Map(seed.splits.map((s) => [s.id, s]));
  const allocated = new Map<string, number>();
  for (const a of seed.settlementAllocations) {
    allocated.set(a.splitShareId, (allocated.get(a.splitShareId) ?? 0) + a.amountCents);
  }
  const debts = seed.splitShares.flatMap((sh): DebtShare[] => {
    const sp = split.get(sh.splitId)!;
    const base = { shareId: sh.id, amountCents: toCents(sh.amountCents), allocatedCents: toCents(allocated.get(sh.id) ?? 0) };
    if (sp.payerPersonId === seed.ownerId && sh.personId !== seed.ownerId) {
      return [{ ...base, counterpartyId: sh.personId, direction: 'incoming' as const }];
    }
    if (sp.payerPersonId !== seed.ownerId && sh.personId === seed.ownerId) {
      return [{ ...base, counterpartyId: sp.payerPersonId, direction: 'outgoing' as const }];
    }
    return [];
  });
  const nets = new Map(computeBidirectionalBalances(debts).map((b) => [b.personId, b.netCents as number]));
  const others = seed.persons.filter((p) => !p.isOwner);
  const view = buildSimplifyView({
    ownerId: seed.ownerId,
    people: others.map((p) => ({ personId: p.id, netCents: nets.get(p.id) ?? 0 })),
    shares: debts.map((d) => ({ counterpartyId: d.counterpartyId, outstandingCents: Math.max(0, d.amountCents - d.allocatedCents) })),
  });
  const byName = (name: string) => nets.get(seed.persons.find((p) => p.name === name)!.id) ?? 0;
  return { nets, view, byName, debts, allocated };
}

describe('buildDemoSeed', () => {
  const seed = buildDemoSeed('2026-10-09');

  it('recovers its day from the owner row', () => {
    const owner = seed.persons.find((p) => p.isOwner)!;
    expect(seedDayFromOwnerCreatedAt(owner.createdAt)).toBe('2026-10-09');
  });

  it('is deterministic for a given day', () => {
    expect(buildDemoSeed('2026-10-09')).toEqual(seed);
  });

  it('dates everything relative to today, never in the future', () => {
    const later = buildDemoSeed('2027-04-01');
    expect(later.transactions.every((t) => t.date < '2027-04-01')).toBe(true);
    expect(later.transactions.every((t) => t.date >= '2026-12-31')).toBe(true);
    const midnight = new Date('2026-10-09T00:00:00Z').getTime();
    for (const rows of [seed.transactions, seed.splits, seed.settlements, seed.imports.map((i) => ({ createdAt: i.importedAt }))]) {
      for (const r of rows) expect(r.createdAt.getTime()).toBeLessThan(midnight);
    }
  });

  it('spans the three bank sources plus manual entries, Discover-heavy', () => {
    const count = (s: string) => seed.transactions.filter((t) => t.source === s).length;
    expect(count('discover')).toBeGreaterThan(count('chase'));
    expect(count('chase')).toBeGreaterThan(count('amex'));
    expect(count('amex')).toBeGreaterThan(0);
    expect(count('manual')).toBeGreaterThan(0);
    expect(seed.transactions.length).toBeGreaterThan(200);
  });

  it('parses every seeded statement with the real importer', () => {
    for (const imp of seed.imports) {
      const detected = detectParser(seed.statements[imp.id]);
      expect(detected.ok && detected.parser.bank).toBe(imp.source);
      expect(seed.transactions.filter((t) => t.importId === imp.id)).toHaveLength(imp.rowCount);
    }
  });

  it('never collides on the dedup index', () => {
    const live = seed.transactions.filter((t) => t.dedupHash !== null && !t.dedupExempt).map((t) => t.dedupHash);
    expect(new Set(live).size).toBe(live.length);
  });

  it('uses every split method, with receipts behind the item splits', () => {
    const methods = new Set(seed.splits.map((s) => s.method));
    expect(methods).toEqual(new Set(['equal', 'amount', 'percent', 'item']));
    const itemSplits = seed.splits.filter((s) => s.method === 'item');
    for (const s of itemSplits) {
      const receipt = seed.receipts.find((r) => r.transactionId === s.transactionId)!;
      const items = seed.receiptItems.filter((i) => i.receiptId === receipt.id);
      expect(items.length).toBeGreaterThan(1);
      expect(seed.receiptItemAssignments.some((a) => items.some((i) => i.id === a.receiptItemId))).toBe(true);
      expect(receipt.image.svg).toContain('<svg');
    }
  });

  it('resolves every split to exactly its total', () => {
    const tx = new Map(seed.transactions.map((t) => [t.id, t]));
    for (const s of seed.splits) {
      const total = seed.splitShares.filter((sh) => sh.splitId === s.id).reduce((acc, sh) => acc + sh.amountCents, 0);
      if (s.transactionId) {
        expect(total).toBe(Math.abs(tx.get(s.transactionId)!.amountCents));
      } else {
        expect(total).toBeGreaterThan(0);
      }
    }
  });

  it('fully allocates every settlement and never over-pays a share', () => {
    const shareAmount = new Map(seed.splitShares.map((s) => [s.id, s.amountCents]));
    const { allocated } = derive(seed);
    for (const [id, amount] of allocated) expect(amount).toBeLessThanOrEqual(shareAmount.get(id)!);
    for (const st of seed.settlements) {
      const placed = seed.settlementAllocations
        .filter((a) => a.settlementId === st.id)
        .reduce((acc, a) => acc + a.amountCents, 0);
      expect(placed).toBe(st.amountCents);
    }
  });

  it('has people owing, owed, settled, and one netted both ways', () => {
    const { byName } = derive(seed);
    expect(byName('Alex')).toBeGreaterThan(0);
    expect(byName('Jordan')).toBeGreaterThan(0);
    expect(byName('Sam')).toBeLessThan(0);
    expect(byName('Priya')).toBeLessThan(0);
    expect(byName('Casey')).toBe(0);
    const morgan = seed.persons.find((p) => p.name === 'Morgan')!.id;
    expect(seed.settlements.filter((s) => s.personId === morgan && s.isOffset)).toHaveLength(2);
  });

  it('ships a sample statement that overlaps the last import', () => {
    const { sampleStatement } = seed;
    const detected = detectParser(sampleStatement.csv);
    expect(detected.ok && detected.parser.bank).toBe('discover');
    expect(sampleStatement.overlapCount).toBeGreaterThanOrEqual(3);
    expect(sampleStatement.rowCount - sampleStatement.overlapCount).toBeGreaterThanOrEqual(10);
  });

  it('holds its shape across a year of reset days', () => {
    // A daily reset rebuilds against a new date; none may break the seed or
    // lose the simplification story. Every third day keeps the sweep fast
    // while still landing on every weekday and month boundary.
    const start = new Date('2026-10-09T00:00:00Z');
    for (let i = 0; i < 366; i += 3) {
      const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const s = buildDemoSeed(day);
      const { view, byName } = derive(s);
      expect(view.transfers.length, day).toBeLessThan(view.perPersonPayments.length);
      expect(byName('Casey'), day).toBe(0);
      expect(new Set(s.splits.map((x) => x.method)).size, day).toBe(4);
      expect(s.sampleStatement.overlapCount, day).toBeGreaterThanOrEqual(2);
      // The bank demonstrations hold on every day: one Amex row held, the
      // split flight synced.
      expect(s.syncSkippedRows.filter((r) => r.reason === 'possible_duplicate'), day).toHaveLength(1);
      const flight = s.transactions.find((t) => t.source === 'plaid' && s.splits.some((x) => x.transactionId === t.id));
      expect(flight, day).toBeDefined();
    }
    // About 12 s alone; 33 s and 82 s in full parallel runs on 2026-10-28
    // (the second while Docker was starting), both timeouts under 30 s.
  }, 120_000);
});

describe('the linked banks', () => {
  const seed = buildDemoSeed('2026-10-09');
  const linked = seed.bankAccounts.map((account) => {
    const ledger = seed.ledgerAccounts.find((l) => l.id === account.ledgerAccountId)!;
    const feed = seed.bankItems.flatMap((i) => i.accounts).find((a) => a.providerAccountId === account.providerAccountId)!.feed;
    return {
      account,
      ledger,
      feed,
      synced: seed.transactions.filter((t) => t.bankAccountId === account.id),
      aside: seed.syncSkippedRows.filter((r) => r.bankAccountId === account.id),
      csv: seed.transactions.filter((t) => t.source === ledger.csvSource),
    };
  });
  const amex = linked.find((l) => l.ledger.csvSource === 'amex')!;
  const chase = linked.find((l) => l.ledger.csvSource === 'chase')!;

  it('links Chase checking and Amex; Discover stays CSV-only', () => {
    expect(linked.map((l) => l.ledger.csvSource).sort()).toEqual(['amex', 'chase']);
    expect(seed.ledgerAccounts.find((l) => l.csvSource === 'discover')!.cutoverDate).toBeNull();
    expect(seed.imports.every((i) => i.ledgerAccountId === seed.ledgerAccounts.find((l) => l.csvSource === i.source)!.id)).toBe(true);
  });

  it('puts every bank row in one place: set aside before the cutover, synced from it', () => {
    for (const { feed, synced, aside, csv, ledger } of linked) {
      const history = feed.seeded.added.map((t) => t.providerTransactionId);
      const placed = [...synced.map((t) => t.providerTransactionId), ...aside.map((r) => r.providerTransactionId)];
      expect(placed.sort()).toEqual([...history].sort());
      expect(synced.every((t) => t.date >= ledger.cutoverDate!)).toBe(true);
      expect(csv.every((t) => t.date < ledger.cutoverDate!)).toBe(true);
      expect(synced.every((t) => t.dedupHash === null && t.source === 'plaid' && t.providerTransactionId !== null)).toBe(true);
    }
  });

  it('holds the Amex purchase that arrived after the cutover with no authorized date, and nothing on Chase', () => {
    const held = amex.aside.filter((r) => r.reason === 'possible_duplicate');
    expect(held).toHaveLength(1);
    expect(held[0].date >= amex.ledger.cutoverDate!).toBe(true);
    const twin = amex.csv.find((t) => t.amountCents === held[0].amountCents && t.date < amex.ledger.cutoverDate!);
    expect(twin).toBeDefined();
    expect(chase.aside.filter((r) => r.reason === 'possible_duplicate')).toEqual([]);
    expect(amex.account.boundaryReviewedAt).toBeNull();
    expect(chase.account.boundaryReviewedAt).not.toBeNull();
  });

  it('carries a CSV row the owner raised, beside the bank row at its original amount', () => {
    const raised = amex.csv.find((t) => t.note !== null)!;
    const bank = amex.aside.find((r) => r.descriptionRaw === raised.descriptionRaw)!;
    expect(raised.amountCents - bank.amountCents).toBe(38_000);
    expect(raised.dedupHash).toBe(
      dedupHash({ source: 'amex', accountLabel: null, date: raised.date, amountCents: bank.amountCents, descriptionRaw: raised.descriptionRaw }),
    );
  });

  it('verifies Amex against a statement its rows match, and leaves Chase checking for the visitor', () => {
    for (const { account, feed } of linked) {
      const statement = seed.bankStatements[account.providerAccountId];
      const rows = feed.seeded.added.map((t) => ({ key: t.providerTransactionId, postedDate: t.date, amountCents: t.amountCents, description: t.descriptionRaw }));
      expect(compareToStatement({ rows, statement, excludedKeys: new Set(), confirmed: true }).passed).toBe(true);
    }
    expect(amex.account.verifiedAt).not.toBeNull();
    expect(chase.account.verifiedAt).toBeNull();
  });

  it('splits a synced Amex flight, which the fourth press changes', () => {
    const flight = amex.synced.find((t) => seed.splits.some((x) => x.transactionId === t.id))!;
    expect(flight).toBeDefined();
    const presses = amex.feed.presses;
    expect(presses).toHaveLength(4);
    const [first, second, third, fourth] = presses;
    const pending = first.added.find((t) => t.pending)!;
    expect(second.added[0]).toMatchObject({ pending: false, pendingTransactionId: pending.providerTransactionId });
    expect(second.added[0].amountCents).toBeGreaterThan(pending.amountCents);
    expect(third.added[0].amountCents).toBeLessThan(0);
    expect(fourth.modified).toEqual([expect.objectContaining({ providerTransactionId: flight.providerTransactionId, amountCents: flight.amountCents + 35_000 })]);
    expect(chase.feed.presses).toHaveLength(1);
  });

  it('dates every synced row and every press on or before today', () => {
    const today = seed.today;
    for (const { feed } of linked) {
      for (const t of [...feed.seeded.added, ...feed.presses.flatMap((p) => [...p.added, ...p.modified])]) {
        expect(t.date <= today && (t.authorizedDate ?? t.date) <= today).toBe(true);
      }
    }
  });
});
