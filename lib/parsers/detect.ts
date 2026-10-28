import { parseCsv } from './csv';
import { chaseParser } from './chase';
import { discoverParser } from './discover';
import { amexParser } from './amex';
import type { BankParser } from './types';

export const UNKNOWN_FORMAT_MESSAGE =
  "Couldn't detect bank format. Expected Chase, Discover, or Amex CSV.";

export type DetectResult =
  | { ok: true; parser: BankParser; dataRows: string[][] }
  | { ok: false; error: string };

// Registry of parsers detect() routes among, matched by exact header.
const PARSERS: BankParser[] = [
  chaseParser,
  discoverParser,
  // Amex's header (`Date,Description,Amount`) is a generic three-column shape.
  // It is unambiguous among these three banks, but if a fourth bank with a
  // similar minimal header is ever added, this exact-header match will need
  // reinforcement (e.g. validating the first data row's shape) or the two will
  // collide.
  amexParser,
];

function headerEquals(expected: readonly string[], actual: string[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((field, i) => field === actual[i])
  );
}

export function detectParser(fileText: string): DetectResult {
  const rows = parseCsv(fileText);
  if (rows.length === 0) {
    return { ok: false, error: UNKNOWN_FORMAT_MESSAGE };
  }

  const [header, ...dataRows] = rows;
  const parser = PARSERS.find((p) => headerEquals(p.header, header));
  if (!parser) {
    return { ok: false, error: UNKNOWN_FORMAT_MESSAGE };
  }

  return { ok: true, parser, dataRows };
}
