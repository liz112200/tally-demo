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

describe('groupRowsByImport with linked accounts', () => {
  const checking = { id: 'acc-1', label: 'First Platypus Bank · Plaid Checking ••0000', lastSyncedAt: '2026-10-22T14:00:00.000Z' };
  const card = { id: 'acc-2', label: 'First Platypus Bank · Plaid Credit Card ••3333', lastSyncedAt: null };
  type SyncRow = Row & { bankAccountId: string | null };
  const synced = (id: string, date: string, bankAccountId: string): SyncRow => ({
    ...row(id, date, null, 'plaid'),
    bankAccountId,
  });
  const rows: SyncRow[] = [
    { ...row('m1', '2026-07-03', null, 'manual'), bankAccountId: null },
    synced('s1', '2026-10-08', 'acc-1'),
    synced('s2', '2026-09-08', 'acc-1'),
    { ...row('c1', '2026-06-02', 'i-new'), bankAccountId: null },
  ];

  it('groups synced rows by account, after manual entries and before uploads, on the All tab', () => {
    const groups = groupRowsByImport({
      all: rows,
      visible: rows,
      imports: [chaseNew],
      accounts: [checking, card],
      tab: 'all',
    })!;
    expect(groups.map((g) => g.key)).toEqual([UNGROUPED_KEY, 'account:acc-1', 'account:acc-2', 'i-new']);
    const checkingGroup = groups[1];
    expect(checkingGroup.account).toEqual(checking);
    expect(checkingGroup.imp).toBeNull();
    expect(checkingGroup.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(checkingGroup.batchDates).toEqual({ from: '2026-09-08', to: '2026-10-08' });
    expect(checkingGroup.batchSize).toBe(2);
    // An enabled account with nothing synced yet still shows, empty.
    expect(groups[2]).toMatchObject({ account: card, rows: [], batchSize: 0, batchDates: null });
  });

  it('shows only account groups on the Linked tab', () => {
    const linked = rows.filter((r) => r.source === 'plaid');
    const groups = groupRowsByImport({
      all: linked,
      visible: linked,
      imports: [chaseNew],
      accounts: [checking],
      tab: 'plaid',
    })!;
    expect(groups.map((g) => g.key)).toEqual(['account:acc-1']);
  });

  it('leaves bank tabs to their uploads', () => {
    const chase = rows.filter((r) => r.source === 'chase');
    const groups = groupRowsByImport({
      all: chase,
      visible: chase,
      imports: [chaseNew],
      accounts: [checking],
      tab: 'chase',
    })!;
    expect(groups.map((g) => g.key)).toEqual(['i-new']);
  });

  it('groups accounts even when there are no uploads at all', () => {
    const linked = rows.filter((r) => r.source === 'plaid');
    const groups = groupRowsByImport({
      all: linked,
      visible: linked,
      imports: [],
      accounts: [checking],
      tab: 'all',
    });
    expect(groups?.map((g) => g.key)).toEqual(['account:acc-1']);
  });

  it('keeps an import group free of account metadata', () => {
    const groups = groupRowsByImport({ all: rows, visible: rows, imports: [chaseNew], tab: 'all' })!;
    const upload = groups.find((g) => g.key === 'i-new')!;
    expect(upload.account).toBeNull();
    expect(upload.imp).toEqual(chaseNew);
  });
});
