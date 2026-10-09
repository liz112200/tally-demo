import { describe, it, expect } from 'vitest';
import { categorize, type CategoryRule } from './categorize';

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
