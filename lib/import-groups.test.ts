import { describe, expect, it } from 'vitest';
import {
  UNGROUPED_KEY,
  backfilledImportName,
  defaultImportName,
  groupRowsByImport,
  importGroupLabel,
  type GroupableRow,
  type ImportGroupMeta,
} from './import-groups';

type Row = GroupableRow & { source: string };

function row(id: string, date: string, importId: string | null, source = 'chase'): Row {
  return { id, date, importId, source };
}

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
const discover = imp({ id: 'i-disc', source: 'discover', importedAt: '2026-07-05' });

describe('groupRowsByImport', () => {
  const rows = [
    row('t1', '2026-06-05', 'i-new'),
    row('t2', '2026-06-01', 'i-new'),
    row('t3', '2026-05-20', 'i-old'),
    row('t4', '2026-06-10', 'i-disc', 'discover'),
    row('t5', '2026-06-11', null, 'manual'),
  ];
  const imports = [chaseNew, discover, chaseOld]; // newest-first

  it('renders flat on the manual tab', () => {
    expect(
      groupRowsByImport({ all: rows, visible: rows, imports, tab: 'manual' }),
    ).toBeNull();
  });

  it('renders flat when the view has no imports', () => {
    const manualOnly = [row('t5', '2026-06-11', null, 'manual')];
    expect(
      groupRowsByImport({ all: manualOnly, visible: manualOnly, imports: [], tab: 'all' }),
    ).toBeNull();
  });

  it('puts manual rows in an ungrouped section at the top of the all tab', () => {
    const groups = groupRowsByImport({ all: rows, visible: rows, imports, tab: 'all' })!;
    expect(groups.map((g) => g.key)).toEqual([
      UNGROUPED_KEY,
      'i-new',
      'i-disc',
      'i-old',
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['t5']);
  });

  it('keeps only the tab source imports on a bank tab', () => {
    const chaseRows = rows.filter((r) => r.source === 'chase');
    const groups = groupRowsByImport({
      all: rows,
      visible: chaseRows,
      imports,
      tab: 'chase',
    })!;
    expect(groups.map((g) => g.key)).toEqual(['i-new', 'i-old']);
  });

  it('preserves the caller sort order inside a group', () => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const groups = groupRowsByImport({ all: rows, visible: sorted, imports, tab: 'all' })!;
    const newGroup = groups.find((g) => g.key === 'i-new')!;
    expect(newGroup.rows.map((r) => r.id)).toEqual(['t2', 't1']);
  });

  it('computes batch dates and size from unfiltered rows', () => {
    const filtered = rows.filter((r) => r.id === 't1');
    const groups = groupRowsByImport({ all: rows, visible: filtered, imports, tab: 'all' })!;
    const newGroup = groups.find((g) => g.key === 'i-new')!;
    expect(newGroup.batchDates).toEqual({ from: '2026-06-01', to: '2026-06-05' });
    expect(newGroup.batchSize).toBe(2);
    expect(newGroup.rows.map((r) => r.id)).toEqual(['t1']);
  });

  it('keeps a group whose rows are all filtered out, empty', () => {
    const groups = groupRowsByImport({ all: rows, visible: [], imports, tab: 'all' })!;
    expect(groups.map((g) => g.key)).toEqual(['i-new', 'i-disc', 'i-old']);
    expect(groups.every((g) => g.rows.length === 0)).toBe(true);
  });

  it('sends rows with an unknown import to the ungrouped bucket', () => {
    const stray = [row('t9', '2026-06-20', 'i-gone')];
    const groups = groupRowsByImport({
      all: stray,
      visible: stray,
      imports: [chaseNew],
      tab: 'chase',
    })!;
    expect(groups.map((g) => g.key)).toEqual(['i-new', UNGROUPED_KEY]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['t9']);
  });
});

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
