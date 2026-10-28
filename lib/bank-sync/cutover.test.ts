import { describe, expect, it } from 'vitest';
import { basisDate, cutoverProblem, defaultCutover, merchantKey, sameMerchant, splitAtCutover, type Cutover } from './cutover';
import type { ProviderTransaction } from './provider';

const row = (id: string, over: Partial<ProviderTransaction> = {}): ProviderTransaction => ({
  providerTransactionId: id,
  providerAccountId: 'acc',
  amountCents: 10_000,
  isoCurrencyCode: 'USD',
  unofficialCurrencyCode: null,
  date: '2026-09-15',
  authorizedDate: null,
  descriptionRaw: `ROW ${id}`,
  pending: false,
  pendingTransactionId: null,
  raw: {},
  ...over,
});

const discover: Cutover = { date: '2026-09-11', basis: 'transaction' };
const chase: Cutover = { date: '2026-09-11', basis: 'posted' };
const split = (cutover: Cutover | null, added: ProviderTransaction[], csvRows: { date: string; amountCents: number; description?: string }[] = []) =>
  splitAtCutover({ cutover, added, modified: [], removed: [], setAsideIds: new Set(), csvRows });

describe('basisDate', () => {
  it('is the posted date for a posted-basis account, else the authorized date when known', () => {
    const t = { date: '2026-09-12', authorizedDate: '2026-09-10' };
    expect(basisDate(t, 'posted')).toBe('2026-09-12');
    expect(basisDate(t, 'transaction')).toBe('2026-09-10');
    expect(basisDate({ date: '2026-09-12', authorizedDate: null }, 'transaction')).toBe('2026-09-12');
  });
});

describe('splitAtCutover', () => {
  it('inserts everything when the ledger account has no CSV history', () => {
    expect(split(null, [row('a', { date: '2024-11-01' })]).added).toHaveLength(1);
  });

  it('never inserts a row before the cutover, in the account basis', () => {
    const r = split(discover, [
      row('before', { date: '2026-09-12', authorizedDate: '2026-09-10' }),
      row('on', { date: '2026-09-11' }),
    ]);
    expect(r.setAside).toEqual([{ row: expect.objectContaining({ providerTransactionId: 'before' }), reason: 'before_cutover' }]);
    expect(r.added.map((t) => t.providerTransactionId)).toEqual(['on']);
    // The same row on Chase checking's posted basis is after the cutover.
    expect(split(chase, [row('before', { date: '2026-09-12', authorizedDate: '2026-09-10' })]).added).toHaveLength(1);
  });

  it('holds a row near the cutover that matches a CSV row: Plaid sent it before its authorized date', () => {
    // On the CSV as 09-10; Plaid first sends it posted 09-11 with no authorized date.
    const r = split(discover, [row('late-date', { date: '2026-09-11', amountCents: 4_750 })], [{ date: '2026-09-10', amountCents: 4_750 }]);
    expect(r.setAside).toEqual([{ row: expect.objectContaining({ providerTransactionId: 'late-date' }), reason: 'possible_duplicate' }]);
    expect(r.added).toEqual([]);
  });

  it('matches each CSV row once, only by equal amount within three days, and only near the cutover', () => {
    const csv = [{ date: '2026-09-10', amountCents: 4_750 }];
    const r = split(discover, [row('one', { date: '2026-09-11', amountCents: 4_750 }), row('two', { date: '2026-09-12', amountCents: 4_750 })], csv);
    expect(r.setAside.map((s) => s.row.providerTransactionId)).toEqual(['one']);
    expect(r.added.map((t) => t.providerTransactionId)).toEqual(['two']);
    expect(split(discover, [row('cents', { date: '2026-09-11', amountCents: 4_751 })], csv).added).toHaveLength(1);
    expect(split(discover, [row('far', { date: '2026-09-14', amountCents: 4_750 })], csv).added).toHaveLength(1);
    expect(split(discover, [row('late', { date: '2026-09-18', amountCents: 4_750 })], [{ date: '2026-09-17', amountCents: 4_750 }]).added).toHaveLength(1);
  });

  it('holds a same-merchant row near the cutover whatever its amount: an edited CSV row or a hold that settled', () => {
    // The CSV row was raised from 110.00 to 120.00 by the owner; the bank sends 110.00 dated after the cutover.
    const csv = [{ date: '2026-09-10', amountCents: 120_000, description: 'SYNTHETIC CAR HIRE    SPRINGFIELD          IL' }];
    const r = split(discover, [row('car', { date: '2026-09-11', amountCents: 110_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' })], csv);
    expect(r.setAside).toEqual([{ row: expect.objectContaining({ providerTransactionId: 'car' }), reason: 'possible_duplicate' }]);
    // Another merchant at another amount is added; so is the same merchant beyond three days or the first week.
    expect(split(discover, [row('other', { date: '2026-09-11', amountCents: 110_000, descriptionRaw: 'EXAMPLE RENTALS' })], csv).added).toHaveLength(1);
    expect(split(discover, [row('later', { date: '2026-09-14', amountCents: 110_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' })], csv).added).toHaveLength(1);
    // The equal amount is matched first, so the same-merchant row is not offered the CSV row it took.
    const both = split(discover, [
      row('same-amount', { date: '2026-09-11', amountCents: 120_000, descriptionRaw: 'SOMETHING ELSE' }),
      row('same-merchant', { date: '2026-09-11', amountCents: 1_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' }),
    ], csv);
    expect(both.setAside.map((x) => x.row.providerTransactionId)).toEqual(['same-amount']);
  });

  it('a change or removal of a set-aside row updates it there and never inserts it', () => {
    const r = splitAtCutover({
      cutover: discover,
      added: [],
      modified: [row('held', { date: '2026-09-20' }), row('stored', { date: '2026-09-20' })],
      removed: [{ providerTransactionId: 'old', providerAccountId: 'acc' }, { providerTransactionId: 'kept', providerAccountId: 'acc' }],
      setAsideIds: new Set(['held', 'old']),
      csvRows: [],
    });
    expect(r.setAside.map((s) => [s.row.providerTransactionId, s.reason])).toEqual([['held', 'possible_duplicate']]);
    expect(r.modified.map((t) => t.providerTransactionId)).toEqual(['stored']);
    expect(r.setAsideRemoved).toEqual(['old']);
    expect(r.removed.map((t) => t.providerTransactionId)).toEqual(['kept']);
  });
});

describe('the cutover date', () => {
  it('defaults to the day after the last CSV row, and refuses any date on or before it', () => {
    expect(defaultCutover('2026-09-10')).toBe('2026-09-11');
    expect(defaultCutover('2026-12-31')).toBe('2027-01-01');
    expect(defaultCutover(null)).toBeNull();
    expect(cutoverProblem('2026-09-11', '2026-09-10')).toBeNull();
    expect(cutoverProblem('2026-09-20', '2026-09-10')).toBeNull();
    expect(cutoverProblem('2026-09-10', '2026-09-10')).toMatch(/counts? those purchases twice/);
    expect(cutoverProblem('', '2026-09-10')).toBe('Enter a date.');
  });
});

describe('merchantKey', () => {
  it('is the first word past wallet and processor prefixes, the same for both sources', () => {
    expect(merchantKey('SYNTHETIC CAR HIRE    SPRINGFIELD          IL')).toBe('SYNTHETIC');
    expect(merchantKey('AplPay NOODLE BARNEW YORK NY')).toBe('NOODLE');
    expect(sameMerchant(merchantKey('AplPay TST* CORNERNEW YORK NY'), merchantKey('TST* CORNER NEW YORK NY'))).toBe(true);
    expect(sameMerchant(merchantKey('SYNTHETIC CAR HIRE'), merchantKey('EXAMPLE RENTALS'))).toBe(false);
    expect(sameMerchant(null, 'SYNTHETIC')).toBe(false);
    expect(merchantKey('AplPay UEP*SNACKS 000NEW YORK NY')).toBe('SNACKS');
  });

  it('is null when nothing of three characters is left', () => {
    expect(merchantKey('AplPay')).toBeNull();
    expect(merchantKey('7 11')).toBeNull();
  });
});
