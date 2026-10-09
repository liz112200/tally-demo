import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectParser, UNKNOWN_FORMAT_MESSAGE } from './detect';

const chaseCsv = readFileSync(
  join(process.cwd(), 'tests/fixtures/chase/sample.csv'),
  'utf8',
);

const discoverCsv = readFileSync(
  join(process.cwd(), 'tests/fixtures/discover/sample.csv'),
  'utf8',
);
const amexCsv = readFileSync(
  join(process.cwd(), 'tests/fixtures/amex/sample.csv'),
  'utf8',
);

describe('detectParser', () => {
  it('routes the Chase checking header to the Chase parser', () => {
    const result = detectParser(chaseCsv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser.bank).toBe('chase');
      expect(result.dataRows.length).toBe(13);
    }
  });

  it('routes the Discover header to the Discover parser', () => {
    const result = detectParser(discoverCsv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser.bank).toBe('discover');
      expect(result.dataRows.length).toBe(12);
    }
  });

  it('routes the Amex header to the Amex parser', () => {
    const result = detectParser(amexCsv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser.bank).toBe('amex');
      expect(result.dataRows.length).toBe(2);
    }
  });

  it('returns unknown-format for a junk blob', () => {
    const result = detectParser('this is not a bank csv');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(UNKNOWN_FORMAT_MESSAGE);
  });

  it('returns unknown-format for an empty file', () => {
    const result = detectParser('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(UNKNOWN_FORMAT_MESSAGE);
  });
});
