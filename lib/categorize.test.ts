import { describe, it, expect } from 'vitest';
import { categorize, type CategoryRule, ruleOutcome } from './categorize';

const rule = (over: Partial<CategoryRule>): CategoryRule => ({
  categoryId: 'cat',
  matchPattern: 'UBER',
  matchType: 'substring',
  priority: 100,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('categorize', () => {
  it('matches a substring', () => {
    expect(categorize('UBER TECHNOLOGIES', [rule({ categoryId: 'transport' })])).toBe(
      'transport',
    );
  });

  it('is case-insensitive', () => {
    expect(
      categorize('uber technologies', [rule({ matchPattern: 'UBER', categoryId: 't' })]),
    ).toBe('t');
    expect(
      categorize('UBER TECHNOLOGIES', [rule({ matchPattern: 'uber', categoryId: 't' })]),
    ).toBe('t');
  });

  it('matches a regex (alternation)', () => {
    const r = rule({ matchPattern: 'UBER|LYFT', matchType: 'regex', categoryId: 'transport' });
    expect(categorize('LYFT *RIDE', [r])).toBe('transport');
    expect(categorize('UBER *TRIP', [r])).toBe('transport');
  });

  it('returns null when nothing matches', () => {
    expect(categorize('NORTHWIND LABS PAYROLL', [rule({ matchPattern: 'UBER' })])).toBeNull();
  });

  it('lets a lower priority win when multiple rules match', () => {
    const rules = [
      rule({ matchPattern: 'AMAZON', categoryId: 'shopping', priority: 100 }),
      rule({ matchPattern: 'AMAZON PRIME', categoryId: 'entertainment', priority: 50 }),
    ];
    expect(categorize('AMAZON PRIME VIDEO', rules)).toBe('entertainment');
  });

  it('breaks ties by created_at ascending', () => {
    const rules = [
      rule({ categoryId: 'later', priority: 100, createdAt: '2026-05-01T00:00:00Z' }),
      rule({ categoryId: 'earlier', priority: 100, createdAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(categorize('UBER TRIP', rules)).toBe('earlier');
  });

  it('ignores an invalid regex rather than throwing', () => {
    const rules = [
      rule({ matchPattern: '(', matchType: 'regex', categoryId: 'bad', priority: 10 }),
      rule({ matchPattern: 'UBER', categoryId: 'good', priority: 20 }),
    ];
    expect(categorize('UBER TRIP', rules)).toBe('good');
  });
});

describe('ruleOutcome', () => {
  const splittable = (id: string) => id !== 'cat-transfers';
  const row = (o: Partial<Parameters<typeof ruleOutcome>[0]> = {}) => ({
    categoryId: null,
    categorySource: null,
    hasSplit: false,
    ...o,
  });

  it('sets a matched category on an uncategorized or rule row', () => {
    expect(ruleOutcome(row(), 'cat-dining', splittable)).toEqual({ categoryId: 'cat-dining', categorySource: 'rule' });
    expect(
      ruleOutcome(row({ categoryId: 'cat-old', categorySource: 'rule' }), 'cat-dining', splittable),
    ).toEqual({ categoryId: 'cat-dining', categorySource: 'rule' });
  });

  it('changes nothing when the rule category is already set', () => {
    expect(ruleOutcome(row({ categoryId: 'cat-dining', categorySource: 'rule' }), 'cat-dining', splittable)).toBeNull();
  });

  it('never touches a manual category, matched or not', () => {
    const manual = row({ categoryId: 'cat-x', categorySource: 'manual' });
    expect(ruleOutcome(manual, 'cat-dining', splittable)).toBeNull();
    expect(ruleOutcome(manual, null, splittable)).toBeNull();
  });

  it('clears a stale rule category; leaves an uncategorized row alone', () => {
    expect(ruleOutcome(row({ categoryId: 'cat-old', categorySource: 'rule' }), null, splittable)).toEqual({
      categoryId: null,
      categorySource: null,
    });
    expect(ruleOutcome(row(), null, splittable)).toBeNull();
  });

  it('never moves a split row into a category that is not splittable', () => {
    expect(ruleOutcome(row({ hasSplit: true }), 'cat-transfers', splittable)).toBeNull();
    expect(
      ruleOutcome(row({ hasSplit: true, categoryId: 'cat-dining', categorySource: 'rule' }), 'cat-transfers', splittable),
    ).toBeNull();
    // Into a splittable one is fine, and so is clearing (uncategorized counts as splittable).
    expect(ruleOutcome(row({ hasSplit: true }), 'cat-dining', splittable)).toEqual({
      categoryId: 'cat-dining',
      categorySource: 'rule',
    });
    expect(
      ruleOutcome(row({ hasSplit: true, categoryId: 'cat-dining', categorySource: 'rule' }), null, splittable),
    ).toEqual({ categoryId: null, categorySource: null });
  });
});

describe('ruleOutcome with the bank\'s category', () => {
  const splittable = (id: string) => id !== 'cat-transfers';
  const row = (o: Partial<Parameters<typeof ruleOutcome>[0]> = {}) => ({ categoryId: null, categorySource: null, hasSplit: false, ...o });

  it('fills an uncategorized row with the bank\'s category, marked as the bank\'s', () => {
    expect(ruleOutcome(row(), null, splittable, 'cat-dining')).toEqual({ categoryId: 'cat-dining', categorySource: 'bank' });
  });

  it('lets a rule win over the bank, on a new match and over a bank row', () => {
    expect(ruleOutcome(row(), 'cat-groceries', splittable, 'cat-dining')).toEqual({ categoryId: 'cat-groceries', categorySource: 'rule' });
    expect(ruleOutcome(row({ categoryId: 'cat-dining', categorySource: 'bank' }), 'cat-groceries', splittable, 'cat-dining')).toEqual({
      categoryId: 'cat-groceries',
      categorySource: 'rule',
    });
  });

  it('never touches a manual category, whatever the bank says', () => {
    expect(ruleOutcome(row({ categoryId: 'cat-travel', categorySource: 'manual' }), null, splittable, 'cat-dining')).toBeNull();
  });

  it('falls back to the bank when a rule stops matching, and clears a bank row the mapping no longer covers', () => {
    expect(ruleOutcome(row({ categoryId: 'cat-groceries', categorySource: 'rule' }), null, splittable, 'cat-dining')).toEqual({
      categoryId: 'cat-dining',
      categorySource: 'bank',
    });
    expect(ruleOutcome(row({ categoryId: 'cat-dining', categorySource: 'bank' }), null, splittable, null)).toEqual({
      categoryId: null,
      categorySource: null,
    });
    expect(ruleOutcome(row({ categoryId: 'cat-dining', categorySource: 'bank' }), null, splittable, 'cat-dining')).toBeNull();
  });

  it('never moves a split row into a category that is not splittable', () => {
    expect(ruleOutcome(row({ hasSplit: true }), null, splittable, 'cat-transfers')).toBeNull();
  });
});

