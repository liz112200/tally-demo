import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('splits a simple unquoted row', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']]);
  });

  it('splits header and data through the same path', () => {
    expect(parseCsv('h1,h2\n1,2\n3,4')).toEqual([
      ['h1', 'h2'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('x,"a,b",z')).toEqual([['x', 'a,b', 'z']]);
  });

  it('handles a quoted field with an embedded comma AND doubled quotes', () => {
    // RFC 4180's nastiest case: the field value is  a,"b"y
    expect(parseCsv('x,"a,""b""y",z')).toEqual([['x', 'a,"b"y', 'z']]);
  });

  it('decodes a field that is only an escaped quote', () => {
    expect(parseCsv('"a,""b"""')).toEqual([['a,"b"']]);
  });

  it('normalizes CRLF line endings', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  it('preserves a trailing empty field (ragged trailing comma)', () => {
    expect(parseCsv('a,b,')).toEqual([['a', 'b', '']]);
  });

  it('returns an empty array for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('treats a header-only file as one row with zero data rows', () => {
    const rows = parseCsv('h1,h2,h3\n');
    expect(rows).toEqual([['h1', 'h2', 'h3']]);
    expect(rows.slice(1)).toEqual([]);
  });
});
