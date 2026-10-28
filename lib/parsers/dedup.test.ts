import { describe, it, expect } from 'vitest';
import { dedupHash, type DedupFields } from './dedup';

const base: DedupFields = {
  source: 'chase',
  accountLabel: 'Sapphire ...1234',
  date: '2026-07-16',
  amountCents: 1234,
  descriptionRaw: 'BLUE BOTTLE COFFEE',
};

describe('dedupHash', () => {
  it('is deterministic: same inputs produce the same hash', () => {
    expect(dedupHash(base)).toBe(dedupHash(base));
  });

  it('produces a 64-char sha256 hex digest', () => {
    expect(dedupHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats accountLabel null and empty string as identical', () => {
    const withNull = dedupHash({ ...base, accountLabel: null });
    const withEmpty = dedupHash({ ...base, accountLabel: '' });
    expect(withNull).toBe(withEmpty);
  });

  it('does not depend on object key order at the call site', () => {
    const reordered: DedupFields = {
      descriptionRaw: base.descriptionRaw,
      amountCents: base.amountCents,
      date: base.date,
      accountLabel: base.accountLabel,
      source: base.source,
    };
    expect(dedupHash(reordered)).toBe(dedupHash(base));
  });

  describe('any single-field change changes the hash', () => {
    const original = dedupHash(base);

    it('source', () => {
      expect(dedupHash({ ...base, source: 'discover' })).not.toBe(original);
    });
    it('accountLabel', () => {
      expect(dedupHash({ ...base, accountLabel: 'Freedom ...9999' })).not.toBe(
        original,
      );
    });
    it('date', () => {
      expect(dedupHash({ ...base, date: '2026-07-17' })).not.toBe(original);
    });
    it('amountCents', () => {
      expect(dedupHash({ ...base, amountCents: 1235 })).not.toBe(original);
    });
    it('descriptionRaw', () => {
      expect(dedupHash({ ...base, descriptionRaw: 'STARBUCKS' })).not.toBe(
        original,
      );
    });
  });

  it('does not collide across delimiter-adjacent field boundaries', () => {
    // Guards the canonical form against ambiguity: moving a '|' worth of text
    // from one field into the next must not yield the same string.
    const a = dedupHash({ ...base, source: 'a', accountLabel: 'b' });
    const b = dedupHash({ ...base, source: 'a|b', accountLabel: '' });
    expect(a).not.toBe(b);
  });
});
