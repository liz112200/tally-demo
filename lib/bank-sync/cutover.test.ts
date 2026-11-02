import { describe, expect, it } from 'vitest';
import { basisDate, cutoverProblem, defaultCutover, merchantKey, pairWithCsv, sameMerchant, splitAtCutover, type Cutover } from './cutover';
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
const split = (
  cutover: Cutover | null,
  added: ProviderTransaction[],
  csvRows: { date: string; amountCents: number; description?: string }[] = [],
  setAsideRows: { date: string; amountCents: number; description: string }[] = [],
) => splitAtCutover({ cutover, added, modified: [], removed: [], setAsideIds: new Set(), setAsideRows, csvRows });

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

  it('matches each CSV row once, only by equal amount within seven days, and only in the first week', () => {
    const csv = [{ date: '2026-09-10', amountCents: 4_750 }];
    const r = split(discover, [row('one', { date: '2026-09-11', amountCents: 4_750 }), row('two', { date: '2026-09-12', amountCents: 4_750 })], csv);
    expect(r.setAside.map((s) => s.row.providerTransactionId)).toEqual(['one']);
    expect(r.added.map((t) => t.providerTransactionId)).toEqual(['two']);
    expect(split(discover, [row('cents', { date: '2026-09-11', amountCents: 4_751 })], csv).added).toHaveLength(1);
    expect(split(discover, [row('far', { date: '2026-09-11', amountCents: 4_750 })], [{ date: '2026-09-03', amountCents: 4_750 }]).added).toHaveLength(1);
    expect(split(discover, [row('late', { date: '2026-09-18', amountCents: 4_750 })], [{ date: '2026-09-17', amountCents: 4_750 }]).added).toHaveLength(1);
  });

  it('holds a same-merchant row near the cutover whatever its amount: an edited CSV row or a hold that settled', () => {
    // The CSV row was raised from 110.00 to 120.00 by the owner; the bank sends 110.00 dated after the cutover.
    const csv = [{ date: '2026-09-10', amountCents: 120_000, description: 'SYNTHETIC CAR HIRE    SPRINGFIELD          IL' }];
    const r = split(discover, [row('car', { date: '2026-09-11', amountCents: 110_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' })], csv);
    expect(r.setAside).toEqual([{ row: expect.objectContaining({ providerTransactionId: 'car' }), reason: 'possible_duplicate' }]);
    // Another merchant at another amount is added; so is the same merchant after the first week.
    expect(split(discover, [row('other', { date: '2026-09-11', amountCents: 110_000, descriptionRaw: 'EXAMPLE RENTALS' })], csv).added).toHaveLength(1);
    expect(split(discover, [row('later', { date: '2026-09-18', amountCents: 110_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' })], csv).added).toHaveLength(1);
    // The equal amount is matched first, so the same-merchant row is not offered the CSV row it took.
    const both = split(discover, [
      row('same-amount', { date: '2026-09-11', amountCents: 120_000, descriptionRaw: 'SOMETHING ELSE' }),
      row('same-merchant', { date: '2026-09-11', amountCents: 1_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' }),
    ], csv);
    expect(both.setAside.map((x) => x.row.providerTransactionId)).toEqual(['same-amount']);
    // Whatever the order rows arrive in: a same-merchant row first must not
    // take the CSV row a later row has at the exact amount, which would add
    // that purchase a second time.
    const reversed = split(discover, [
      row('same-merchant', { date: '2026-09-11', amountCents: 1_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' }),
      row('exact', { date: '2026-09-12', amountCents: 120_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' }),
    ], csv);
    expect(reversed.setAside.map((x) => x.row.providerTransactionId)).toEqual(['exact']);
    expect(reversed.added.map((t) => t.providerTransactionId)).toEqual(['same-merchant']);
  });

  it('holds a purchase that posts four days after the CSV date, past the old three-day window', () => {
    // The largest lag seen was three days; a fourth would have counted this twice.
    const r = split(discover, [row('slow', { date: '2026-09-11', amountCents: 2_260 })], [{ date: '2026-09-07', amountCents: 2_260 }]);
    expect(r.setAside.map((s) => [s.row.providerTransactionId, s.reason])).toEqual([['slow', 'possible_duplicate']]);
  });

  it('a CSV row whose bank twin already arrived is not offered to a first-week row', () => {
    const fare = { amountCents: 2_900, description: 'SYNTHETIC TRANSIT FARE' };
    const csv = [{ date: '2026-09-06', ...fare }, { date: '2026-09-07', ...fare }, { date: '2026-09-10', ...fare }];
    const first = row('first-week', { date: '2026-09-11', amountCents: 2_900, descriptionRaw: 'SYNTHETIC TRANSIT FARE' });
    const later = row('later-week', { date: '2026-09-13', amountCents: 2_900, descriptionRaw: 'SYNTHETIC TRANSIT FARE' });
    // Set aside by an earlier sync, posted the day after the CSV rows of 09-06 and 09-07.
    const earlier = [{ date: '2026-09-07', ...fare }, { date: '2026-09-08', ...fare }];
    const r = split(discover, [first, later], csv, earlier);
    expect(r.setAside.map((s) => s.row.providerTransactionId)).toEqual(['first-week']);
    expect(r.added.map((t) => t.providerTransactionId)).toEqual(['later-week']);
    // The same when they arrive in this sync, dated before the cutover.
    const now = split(discover, [
      row('b1', { date: '2026-09-07', amountCents: 2_900, descriptionRaw: 'SYNTHETIC TRANSIT FARE' }),
      row('b2', { date: '2026-09-08', amountCents: 2_900, descriptionRaw: 'SYNTHETIC TRANSIT FARE' }),
      first,
      later,
    ], csv);
    expect(now.setAside.map((s) => [s.row.providerTransactionId, s.reason])).toEqual([
      ['b1', 'before_cutover'],
      ['b2', 'before_cutover'],
      ['first-week', 'possible_duplicate'],
    ]);
    // Without them, both first-week fares would take a CSV row.
    expect(split(discover, [first, later], csv).setAside).toHaveLength(2);
  });

  it('on a posted-basis account, matches a CSV row on the posting date, not the purchase date', () => {
    // On the CSV posted 09-10; the bank posts it 09-11 with a purchase date of 09-06.
    const csv = [{ date: '2026-09-10', amountCents: 4_750 }];
    const r = split(chase, [row('late', { date: '2026-09-11', authorizedDate: '2026-09-06', amountCents: 4_750 })], csv);
    expect(r.setAside).toEqual([{ row: expect.objectContaining({ providerTransactionId: 'late' }), reason: 'possible_duplicate' }]);
  });

  it('a change or removal of a set-aside row updates it there and never inserts it', () => {
    const r = splitAtCutover({
      cutover: discover,
      added: [],
      modified: [row('held', { date: '2026-09-20' }), row('stored', { date: '2026-09-20' })],
      removed: [{ providerTransactionId: 'old', providerAccountId: 'acc' }, { providerTransactionId: 'kept', providerAccountId: 'acc' }],
      setAsideIds: new Set(['held', 'old']),
      setAsideRows: [],
      csvRows: [],
    });
    expect(r.setAside.map((s) => [s.row.providerTransactionId, s.reason])).toEqual([['held', 'possible_duplicate']]);
    expect(r.modified.map((t) => t.providerTransactionId)).toEqual(['stored']);
    expect(r.setAsideRemoved).toEqual(['old']);
    expect(r.removed.map((t) => t.providerTransactionId)).toEqual(['kept']);
  });
});

describe('pairWithCsv', () => {
  const grocer = (date: string, amountCents: number) => ({ date, amountCents, description: 'SYNTHETIC GROCER #12 SPRINGFIELD' });
  it('pairs every equal amount before any merchant, one CSV row per bank row', () => {
    const csv = [grocer('2026-09-03', 3_150), grocer('2026-09-09', 1_420)];
    const bank = [grocer('2026-09-06', 3_150), grocer('2026-09-11', 1_420), grocer('2026-09-10', 9_990)];
    expect(pairWithCsv(bank, csv)).toEqual([0, 1, null]);
  });
  it('pairs by merchant at another amount only what no equal amount took, nearest first', () => {
    const csv = [grocer('2026-09-08', 4_000), grocer('2026-09-10', 4_400)];
    expect(pairWithCsv([grocer('2026-09-11', 5_000), grocer('2026-09-09', 4_000)], csv)).toEqual([1, 0]);
  });
  it('never pairs beyond seven days, another merchant at another amount, or a CSV row twice', () => {
    expect(pairWithCsv([grocer('2026-09-17', 1_420)], [grocer('2026-09-09', 1_420)])).toEqual([null]);
    expect(pairWithCsv([grocer('2026-09-16', 1_420)], [grocer('2026-09-09', 1_420)])).toEqual([0]);
    expect(pairWithCsv([{ date: '2026-09-10', amountCents: 500, description: 'EXAMPLE CINEMA' }], [grocer('2026-09-09', 1_420)])).toEqual([null]);
    expect(pairWithCsv([grocer('2026-09-10', 1_420), grocer('2026-09-10', 1_420)], [grocer('2026-09-09', 1_420)])).toEqual([0, null]);
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
