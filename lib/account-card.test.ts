import { describe, expect, it } from 'vitest';
import { accountCard, isUnverified } from './account-card';
import type { PeriodRow, PeriodStatement } from './statement-periods';

// Invented accounts, days and amounts.
let n = 0;
const row = (date: string, amountCents: number, over: Partial<PeriodRow> = {}): PeriodRow => ({
  id: `r${++n}`,
  date,
  postedDate: date,
  amountCents,
  source: 'plaid',
  pending: false,
  unverified: false,
  alongsideOfId: null,
  ...over,
});
const statement = (closingDate: string, over: Partial<PeriodStatement> = {}): PeriodStatement => ({
  closingDate,
  periodStart: null,
  nextClosingDate: null,
  startsNewCycle: false,
  chargesCents: null,
  creditsCents: null,
  ...over,
});
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const money = (mills: number) => `$${(mills / 1000).toFixed(2)}`;
const card = (statements: PeriodStatement[], rows: PeriodRow[], over: { held?: number; unverified?: boolean; linked?: boolean; kind?: 'card' | 'checking' } = {}) =>
  accountCard({
    ledger: { id: 'l', label: 'Card One', kind: over.kind ?? 'card', purchaseDatedCsv: false, statements },
    rows,
    linked: over.linked ?? true,
    held: over.held ?? 0,
    unverified: over.unverified ?? false,
    today: '2026-08-20',
    formatDay: day,
    formatMoney: money,
  });

describe('accountCard', () => {
  const steady = [statement('2026-05-11'), statement('2026-06-11'), statement('2026-07-11', { periodStart: '2026-06-12', chargesCents: 9_000, creditsCents: 2_000 })];

  it('carries the cycle with its count and this cycle so far, by statement figures', () => {
    const upToDate = [statement('2026-06-11'), statement('2026-07-11'), statement('2026-08-11')];
    const c = card(upToDate, [row('2026-07-20', 9_000), row('2026-07-21', -2_000), row('2026-08-14', 4_250), row('2026-08-15', -1_000)]);
    expect(c.kind).toBe('Card · linked');
    expect(c.cycle).toMatchObject({ range: 'Aug 12 – closes Sep 11', count: '3 statements', left: '22 days left' });
    expect(c.figures).toEqual([
      { label: 'Charges', mills: 4_250 },
      { label: 'Payments and credits', mills: 1_000 },
    ]);
  });

  it('says whether the latest compared statement agrees, with the difference', () => {
    expect(card(steady, [row('2026-06-20', 9_000), row('2026-06-21', -2_000)]).chips).toEqual([{ label: 'Jul 11 statement matches', tone: 'ok' }]);
    expect(card(steady, [row('2026-06-20', 8_000), row('2026-06-21', -2_000)]).chips).toEqual([{ label: 'Jul 11: $1.00 under', tone: 'warn' }]);
  });

  it('names questions, trust and missing statements, in the words of a checking account where it is one', () => {
    const c = card([], [row('2026-08-14', 4_250)], { held: 2, unverified: true, linked: false, kind: 'checking' });
    expect(c.kind).toBe('Checking · CSV only');
    expect(c.cycle).toBeNull();
    expect(c.chips.map((x) => x.label)).toEqual(['2 questions', 'Not verified yet', 'No statements']);
    expect(c.figures.map((f) => f.label)).toEqual(['Withdrawals', 'Deposits']);
  });
});

describe('isUnverified', () => {
  const state = (over: Partial<{ verifiedAt: Date | null; heldCount: number; ledgerAccountId: string | null }> = {}) => ({
    verifiedAt: null,
    heldCount: 0,
    ledgerAccountId: 'l',
    ...over,
  });
  it('is a set-up account that syncs, has rows or holds one, with no passed check', () => {
    expect(isUnverified({ syncEnabled: true, rowCount: 0 }, state())).toBe(true);
    expect(isUnverified({ syncEnabled: false, rowCount: 3 }, state())).toBe(true);
    expect(isUnverified({ syncEnabled: false, rowCount: 0 }, state({ heldCount: 1 }))).toBe(true);
    expect(isUnverified({ syncEnabled: false, rowCount: 0 }, state())).toBe(false);
    expect(isUnverified({ syncEnabled: true, rowCount: 3 }, state({ verifiedAt: new Date('2026-08-01') }))).toBe(false);
    expect(isUnverified({ syncEnabled: true, rowCount: 3 }, state({ ledgerAccountId: null }))).toBe(false);
  });
});
