import { describe, expect, it } from 'vitest';
import { canHardDeletePerson, isPersonVisible } from './people-visibility';

describe('isPersonVisible', () => {
  it('always shows active people, even with no activity', () => {
    expect(
      isPersonVisible({ deleted: false, shareCount: 0, settlementCount: 0 }),
    ).toBe(true);
  });

  it('hides a soft-deleted person with no shares and no settlements', () => {
    expect(
      isPersonVisible({ deleted: true, shareCount: 0, settlementCount: 0 }),
    ).toBe(false);
  });

  it('keeps a soft-deleted person with a leftover settlement', () => {
    expect(
      isPersonVisible({ deleted: true, shareCount: 0, settlementCount: 1 }),
    ).toBe(true);
  });

  it('keeps a soft-deleted person with leftover shares', () => {
    expect(
      isPersonVisible({ deleted: true, shareCount: 2, settlementCount: 0 }),
    ).toBe(true);
  });

  it('keeps a balanced-to-zero deleted person that still has rows', () => {
    // $10 share and a matching $10 settlement net to $0, but the rows are
    // real, so the person stays visible (balance can't gate this).
    expect(
      isPersonVisible({ deleted: true, shareCount: 1, settlementCount: 1 }),
    ).toBe(true);
  });
});

describe('canHardDeletePerson', () => {
  it('refuses active people', () => {
    expect(
      canHardDeletePerson({ deleted: false, shareCount: 0, settlementCount: 5 }),
    ).toBe(false);
  });

  it('allows a soft-deleted person with only leftover settlements', () => {
    expect(
      canHardDeletePerson({ deleted: true, shareCount: 0, settlementCount: 3 }),
    ).toBe(true);
  });

  it('refuses a soft-deleted person that still has active shares', () => {
    // Hard-deleting would strip them out of a live split, corrupting its
    // share sum — so it is never offered.
    expect(
      canHardDeletePerson({ deleted: true, shareCount: 1, settlementCount: 0 }),
    ).toBe(false);
  });
});
