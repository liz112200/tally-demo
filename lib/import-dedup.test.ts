import { describe, expect, it } from 'vitest';
import { classifyDuplicate, planImportRow } from './import-dedup';

describe('classifyDuplicate', () => {
  it('returns null for a hash with no existing row', () => {
    expect(classifyDuplicate(undefined)).toBeNull();
  });

  it('flags a collision with a live row as active', () => {
    expect(classifyDuplicate({ deleted: false })).toBe('active');
  });

  it('flags a collision with a soft-deleted row as deleted', () => {
    expect(classifyDuplicate({ deleted: true })).toBe('deleted');
  });
});

describe('planImportRow', () => {
  it('always inserts a new row, regardless of approval', () => {
    expect(planImportRow(false, false)).toBe('insert');
    expect(planImportRow(false, true)).toBe('insert');
  });

  it('skips an unapproved duplicate', () => {
    expect(planImportRow(true, false)).toBe('skip');
  });

  it('forces an approved duplicate past the index', () => {
    expect(planImportRow(true, true)).toBe('force');
  });
});
