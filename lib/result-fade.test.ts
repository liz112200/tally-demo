import { describe, expect, it } from 'vitest';
import { fadesAway } from './result-fade';

describe('fadesAway', () => {
  it('fades a confirmation that carries no figures', () => {
    expect(fadesAway({ kind: 'success', text: 'Kept out: the same purchase as the CSV row.' })).toBe(true);
    expect(fadesAway({ kind: 'success', text: 'Boundary review done.' })).toBe(true);
  });

  it('keeps anything with a figure, in its text or its details', () => {
    expect(fadesAway({ kind: 'success', text: 'Synced: 3 new, 1 updated.' })).toBe(false);
    expect(fadesAway({ kind: 'success', text: 'Converted.', details: ['Alex owes $19.00 → $19.00'] })).toBe(false);
    expect(fadesAway({ kind: 'success', text: 'Import undone: 12 rows deleted. Restore brings them back.' })).toBe(false);
  });

  it('never fades a warning or an error', () => {
    expect(fadesAway({ kind: 'warning', text: 'Partly done.' })).toBe(false);
    expect(fadesAway({ kind: 'error', text: 'That mark is already cleared.' })).toBe(false);
  });
});
