import { describe, expect, it } from 'vitest';
import { needsYouItems, type NeedsYouFacts } from './needs-you';

// Invented names, dates and amounts.
const none: NeedsYouFacts = {
  held: [],
  disagreements: [],
  logins: [],
  unverified: [],
  withoutTotals: [],
  missingStatements: [],
  noStatements: [],
  flaggedRows: 0,
  raisedRows: 0,
  pointOut: [],
};
const format = {
  day: (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  money: (mills: number) => `$${(mills / 1000).toFixed(2)}`,
};

describe('needsYouItems', () => {
  it('is empty when nothing is outstanding: the band shows All clear', () => {
    expect(needsYouItems(none, format)).toEqual([]);
  });

  it('words each fact with its subject first, and orders questions, problems, trust, tasks', () => {
    const items = needsYouItems(
      {
        ...none,
        raisedRows: 2,
        unverified: [{ bankAccountId: 'b1', name: 'Card Two' }],
        held: [{ ledgerId: 'l1', name: 'Card One', count: 1 }],
        disagreements: [
          {
            ledgerId: 'l3',
            name: 'Card Three',
            kind: 'card',
            closingDate: '2026-08-03',
            charges: { statedCents: 1_320_400, listedCents: 1_306_200 },
            credits: { statedCents: 500_000, listedCents: 500_000 },
          },
        ],
      },
      format,
    );
    expect(items.map((i) => [i.kind, i.subject, i.text, i.action, i.href])).toEqual([
      ['question', 'Card One', '1 bank row is held as a possible duplicate of a CSV row. Same purchase, or a different one?', 'Answer', '/accounts/l1#review'],
      ['problem', 'Card Three', 'the Aug 3 statement says $1320.40 in charges; its rows here total $1306.20, $14.20 less.', 'Compare', '/accounts/l3#periods'],
      ['trust', 'Card Two', 'not checked against a statement, so its synced rows count in no total.', 'Verify', '/accounts/verify/b1'],
      ['task', 'Raised rows', '2 rows raised to fold in what someone owed can move that part into an owes-me line.', 'Review', '/expenses?review=raised'],
    ]);
  });

  it('a statement whose totals agree with its rows raises nothing', () => {
    const agrees = needsYouItems(
      {
        ...none,
        disagreements: [
          { ledgerId: 'l', name: 'Card', kind: 'card', closingDate: '2026-08-03', charges: { statedCents: 1, listedCents: 1 }, credits: null },
        ],
      },
      format,
    );
    expect(agrees).toEqual([]);
  });

  it('names checking sides as a checking statement does, both sides when both differ', () => {
    const [item] = needsYouItems(
      {
        ...none,
        disagreements: [
          {
            ledgerId: 'l',
            name: 'Checking',
            kind: 'checking',
            closingDate: '2026-08-31',
            charges: { statedCents: 10_000, listedCents: 12_000 },
            credits: { statedCents: 5_000, listedCents: 4_000 },
          },
        ],
      },
      format,
    );
    expect(item.text).toBe(
      'the Aug 31 statement says $10.00 in withdrawals; its rows here total $12.00, $2.00 more; and says $5.00 in deposits; its rows here total $4.00, $1.00 less.',
    );
  });

  it('points out uncategorized rows a point-out rule matches, by its category, and nothing at zero', () => {
    const items = needsYouItems(
      {
        ...none,
        pointOut: [
          { ruleId: 'r1', pattern: 'PAYMENT APP', categoryName: 'Settling up', count: 3 },
          { ruleId: 'r2', pattern: 'NOTHING', categoryName: 'Gifts', count: 0 },
        ],
      },
      format,
    );
    expect(items.map((i) => [i.subject, i.text, i.action, i.href])).toEqual([
      ['Settling up', '3 rows match your "PAYMENT APP" rule and have no category.', 'Sort', '/expenses?point=r1'],
    ]);
  });
});
