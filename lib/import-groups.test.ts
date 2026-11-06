import { describe, expect, it } from 'vitest';
import { backfilledImportName, defaultImportName, importGroupLabel, type ImportGroupMeta } from './import-groups';

function imp(overrides: Partial<ImportGroupMeta> & { id: string }): ImportGroupMeta {
  return {
    source: 'chase',
    filename: null,
    displayName: null,
    importedAt: '2026-07-01',
    rowCount: 1,
    backfilled: true,
    hidden: false,
    ...overrides,
  };
}

const chaseNew = imp({
  id: 'i-new',
  filename: 'chase-june.csv',
  importedAt: '2026-07-10',
  backfilled: false,
});
const chaseOld = imp({ id: 'i-old', importedAt: '2026-07-01' });

describe('importGroupLabel', () => {
  it('prefers the display name when present', () => {
    expect(
      importGroupLabel(imp({ id: 'x', displayName: 'Chase 06/01 – 07/07' })),
    ).toBe('Chase 06/01 – 07/07');
  });

  it('falls back to the filename when there is no display name', () => {
    expect(importGroupLabel(chaseNew)).toBe('chase-june.csv');
  });

  it('falls back to "Untitled import" when neither is set', () => {
    expect(importGroupLabel(chaseOld)).toBe('Untitled import');
  });
});

describe('import name generators', () => {
  it('formats a fresh import as "<Source> MM/DD – MM/DD"', () => {
    expect(defaultImportName('discover', '2026-06-12', '2026-07-09')).toBe(
      'Discover 06/12 – 07/09',
    );
    expect(defaultImportName('amex', '2026-06-24', '2026-07-08')).toBe(
      'Amex 06/24 – 07/08',
    );
  });

  it('formats a backfill import as "<Source> (backfilled)"', () => {
    expect(backfilledImportName('chase')).toBe('Chase (backfilled)');
  });
});
