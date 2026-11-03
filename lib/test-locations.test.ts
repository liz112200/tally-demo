import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import unit from '../vitest.config';
import database from '../vitest.db.config';

// A test file outside the directories a runner covers does not fail, it
// never runs (CLAUDE.md, Architecture): a helper's test written under db/ as
// *.test.ts sat outside both suites until the unit count failed to rise
// (2026-11-02). Every test file in the repository must match one runner's
// include pattern.

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', '.next', '.git', '.vercel', '.cursor']);
const TEST_FILE = /\.(test|dbtest|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (TEST_FILE.test(entry.name)) out.push(relative(ROOT, path));
  }
  return out;
}

// The include patterns in use: `**/` (any directories, or none) and `*`.
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`);
}

describe('test file locations', () => {
  const patterns = [...(unit.test?.include ?? []), ...(database.test?.include ?? [])].map(globToRegExp);
  const files = walk(ROOT);

  it('finds the test files, so a pass is not vacuous', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('lib/test-locations.test.ts');
  });

  it('every test file is run by the unit or the database suite', () => {
    expect(files.filter((f) => !patterns.some((p) => p.test(f)))).toEqual([]);
  });

  it('the pattern reading is right', () => {
    expect(globToRegExp('lib/**/*.test.ts').test('lib/money.test.ts')).toBe(true);
    expect(globToRegExp('lib/**/*.test.ts').test('lib/demo/env-file.test.ts')).toBe(true);
    expect(globToRegExp('lib/**/*.test.ts').test('db/demo-env.test.ts')).toBe(false);
    expect(globToRegExp('db/**/*.dbtest.ts').test('db/ledger.dbtest.ts')).toBe(true);
  });
});
