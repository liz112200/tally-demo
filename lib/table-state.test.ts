import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  nextSort,
  readSort,
  sortPatch,
  sortRows,
  type SortSpec,
} from './table-state';

const spec: SortSpec = {
  columns: ['date', 'descriptionRaw', 'amountCents'],
  defaultSort: 'date',
  defaultDir: 'desc',
  firstDir: { date: 'desc', amountCents: 'desc' },
};

describe('readSort', () => {
  it('falls back to the default when params are absent', () => {
    expect(readSort(new URLSearchParams(), spec)).toEqual({
      sort: 'date',
      dir: 'desc',
    });
  });

  it('reads a valid sort and dir', () => {
    expect(readSort(new URLSearchParams('sort=amountCents&dir=asc'), spec)).toEqual({
      sort: 'amountCents',
      dir: 'asc',
    });
  });

  it('rejects unknown columns', () => {
    expect(readSort(new URLSearchParams('sort=dropTable&dir=asc'), spec)).toEqual({
      sort: 'date',
      dir: 'desc',
    });
  });

  it('falls back to the column firstDir on a bad dir', () => {
    expect(readSort(new URLSearchParams('sort=date&dir=sideways'), spec)).toEqual({
      sort: 'date',
      dir: 'desc',
    });
    expect(
      readSort(new URLSearchParams('sort=descriptionRaw&dir=sideways'), spec),
    ).toEqual({ sort: 'descriptionRaw', dir: 'asc' });
  });
});

describe('nextSort', () => {
  it('reverses when the active column is clicked again', () => {
    expect(nextSort({ sort: 'date', dir: 'desc' }, 'date', spec)).toEqual({
      sort: 'date',
      dir: 'asc',
    });
    expect(nextSort({ sort: 'date', dir: 'asc' }, 'date', spec)).toEqual({
      sort: 'date',
      dir: 'desc',
    });
  });

  it('starts a new column in its natural direction', () => {
    expect(nextSort({ sort: 'date', dir: 'desc' }, 'descriptionRaw', spec)).toEqual({
      sort: 'descriptionRaw',
      dir: 'asc',
    });
    expect(nextSort({ sort: 'date', dir: 'desc' }, 'amountCents', spec)).toEqual({
      sort: 'amountCents',
      dir: 'desc',
    });
  });
});

describe('sortPatch / applyPatch round-trip', () => {
  it('keeps the default sort out of the URL', () => {
    const params = applyPatch(
      new URLSearchParams('sort=amountCents&dir=asc'),
      sortPatch({ sort: 'date', dir: 'desc' }, spec),
    );
    expect(params.toString()).toBe('');
  });

  it('round-trips every non-default state', () => {
    for (const sort of spec.columns) {
      for (const dir of ['asc', 'desc'] as const) {
        const params = applyPatch(
          new URLSearchParams(),
          sortPatch({ sort, dir }, spec),
        );
        expect(readSort(params, spec)).toEqual({ sort, dir });
      }
    }
  });

  it('preserves unrelated params', () => {
    const params = applyPatch(
      new URLSearchParams('q=coffee'),
      sortPatch({ sort: 'amountCents', dir: 'desc' }, spec),
    );
    expect(params.get('q')).toBe('coffee');
    expect(readSort(params, spec)).toEqual({ sort: 'amountCents', dir: 'desc' });
  });
});

describe('sortRows', () => {
  const rows = [
    { name: 'banana', cents: 300 },
    { name: 'Apple', cents: -50 },
    { name: 'cherry', cents: null },
  ];

  it('sorts strings case-insensitively', () => {
    expect(sortRows(rows, (r) => r.name, 'asc').map((r) => r.name)).toEqual([
      'Apple',
      'banana',
      'cherry',
    ]);
  });

  it('sorts numbers numerically and keeps nulls last in both directions', () => {
    expect(sortRows(rows, (r) => r.cents, 'asc').map((r) => r.cents)).toEqual([
      -50, 300, null,
    ]);
    expect(sortRows(rows, (r) => r.cents, 'desc').map((r) => r.cents)).toEqual([
      300, -50, null,
    ]);
  });

  it('is stable for ties', () => {
    const tied = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 0 },
    ];
    expect(sortRows(tied, (r) => r.v, 'asc').map((r) => r.id)).toEqual([
      'c', 'a', 'b',
    ]);
  });
});
