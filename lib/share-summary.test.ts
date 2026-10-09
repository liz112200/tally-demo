import { describe, expect, it } from 'vitest';
import { absoluteShareUrl, buildShareSummary, type ShareLine } from './share-summary';

// Amounts are mills (1 dollar = 1000 units), per the money invariant.
const line = (over: Partial<ShareLine> = {}): ShareLine => ({
  date: '2026-07-12',
  description: "Trader Joe's",
  outstandingCents: 24_500,
  category: 'Groceries',
  ...over,
});

const summary = (over: Partial<Parameters<typeof buildShareSummary>[0]> = {}) =>
  buildShareSummary({ personName: 'Alex', owed: [], owing: [], ...over });

describe('buildShareSummary', () => {
  it('returns an empty string when neither side owes anything', () => {
    expect(summary()).toBe('');
  });

  it('renders one direction with its total and the net', () => {
    expect(
      summary({
        owed: [line(), line({ date: '2026-07-15', description: 'Dinner', outstandingCents: 31_000 })],
      }),
    ).toBe(
      [
        "Hi Alex — here's where we're at:",
        '',
        'What you owe me (2 items) — $55.50',
        "  07/12  Trader Joe's — $24.50",
        '  07/15  Dinner — $31.00',
        '',
        'Net: you owe me $55.50',
      ].join('\n'),
    );
  });

  // The bug this rewrite fixes: a one-sided message overstated the debt.
  it('includes what the owner owes and nets the two directions', () => {
    const text = summary({
      owed: [line({ outstandingCents: 1_250_675, description: 'Groceries' })],
      owing: [line({ outstandingCents: 282_905, description: 'Rent' })],
    });
    expect(text).toContain('What you owe me (1 item) — $1,250.675');
    expect(text).toContain('What I owe you (1 item) — $282.905');
    expect(text).toContain('Net: you owe me $967.77');
  });

  it('flips the net wording when the owner owes more', () => {
    expect(
      summary({
        owed: [line({ outstandingCents: 1_000 })],
        owing: [line({ outstandingCents: 5_000 })],
      }),
    ).toContain('Net: I owe you $4.00');
  });

  it('says settled up when the directions cancel', () => {
    expect(
      summary({
        owed: [line({ outstandingCents: 5_000 })],
        owing: [line({ outstandingCents: 5_000 })],
      }),
    ).toContain('Net: we’re settled up');
  });

  it('omits a section that has nothing in it', () => {
    const text = summary({ owing: [line()] });
    expect(text).not.toContain('What you owe me');
    expect(text).toContain('What I owe you');
  });

  it('truncates each section to the limit and links the full list', () => {
    const text = summary({
      limit: 2,
      linkUrl: 'https://t.app/s/abc',
      owed: [
        line({ description: 'A', outstandingCents: 1_000 }),
        line({ description: 'B', outstandingCents: 2_000 }),
        line({ description: 'C', outstandingCents: 3_000 }),
        line({ description: 'D', outstandingCents: 4_000 }),
      ],
    });
    expect(text).toContain('  07/12  A — $1.00');
    expect(text).toContain('  07/12  B — $2.00');
    expect(text).not.toContain('  07/12  C');
    expect(text).toContain('  …and 2 more');
    expect(text).toContain('Full list: https://t.app/s/abc');
    // The section total still covers every line, not just the shown ones.
    expect(text).toContain('What you owe me (4 items) — $10.00');
  });

  it('does not link when the limit withheld nothing', () => {
    const text = summary({
      limit: 5,
      linkUrl: 'https://t.app/s/abc',
      owed: [line(), line()],
    });
    expect(text).not.toContain('Full list');
    expect(text).not.toContain('more');
  });

  it('groups by category with subtotals, keeping the caller order', () => {
    const text = summary({
      groupBy: 'category',
      owed: [
        line({ category: 'Transport', description: 'Uber', outstandingCents: 6_470 }),
        line({ category: 'Groceries', description: 'TJ', outstandingCents: 24_500 }),
        line({ category: 'Groceries', description: 'Target', outstandingCents: 2_720 }),
      ],
    });
    expect(text.indexOf('Transport ($6.47)')).toBeLessThan(
      text.indexOf('Groceries ($27.22)'),
    );
  });

  it('labels a null category rather than dropping the row', () => {
    expect(summary({ groupBy: 'category', owed: [line({ category: null })] })).toContain(
      'Uncategorized ($24.50)',
    );
  });

  it('drops category headings when truncating, since the prefix is partial', () => {
    const text = summary({
      groupBy: 'category',
      limit: 1,
      linkUrl: 'https://t.app/s/abc',
      owed: [line({ category: 'Dining' }), line({ category: 'Groceries' })],
    });
    expect(text).not.toContain('Dining (');
    expect(text).toContain('…and 1 more');
  });

  it('keeps sub-cent amounts exact (mills)', () => {
    expect(summary({ owed: [line({ outstandingCents: 80_765 })] })).toContain('$80.765');
  });
});

describe('absoluteShareUrl', () => {
  // The bug: Vercel shows domains without a scheme, and a scheme-less link
  // arrives in a message as unclickable text.
  it('adds https:// to a bare host', () => {
    expect(absoluteShareUrl('share-snowy-seven.vercel.app', 'abc')).toBe(
      'https://share-snowy-seven.vercel.app/s/abc',
    );
  });

  it('keeps an explicit scheme, so localhost stays http', () => {
    expect(absoluteShareUrl('http://localhost:3000', 'abc')).toBe(
      'http://localhost:3000/s/abc',
    );
    expect(absoluteShareUrl('https://x.app', 'abc')).toBe('https://x.app/s/abc');
  });

  it('tolerates a trailing slash and stray whitespace', () => {
    expect(absoluteShareUrl('  https://x.app/  ', 'abc')).toBe('https://x.app/s/abc');
    expect(absoluteShareUrl('x.app///', 'abc')).toBe('https://x.app/s/abc');
  });
});
