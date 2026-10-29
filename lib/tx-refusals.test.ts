// The transaction rule (CLAUDE.md, Architecture), enforced structurally: no
// database transaction returns a refusal after it has written, because a
// return commits the write. The source is read from the filesystem, like the
// action, auth and environment conventions, so a new transaction is checked
// without anyone remembering to add it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { returnsAfterWrites, returnsAfterWritesInProject } from './tx-refusals';

const root = process.cwd();
function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(e.name) && !/\.(test|dbtest)\.ts$/.test(e.name) ? [{ file: path, text: readFileSync(join(root, path), 'utf8') }] : [];
  });
}
const scan = (text: string) => returnsAfterWrites([{ file: 'x.ts', text }]).map((f) => f.line);

describe('database transactions', () => {
  it('none in the codebase returns a refusal after writing', () => {
    const ours = (f: string) => /\/(db|app|lib)\//.test(f) && !f.includes('node_modules') && !/\.(test|dbtest)\.ts$/.test(f);
    expect(sources('db').some((s) => s.file === join('db', 'alongside.ts'))).toBe(true);
    const { findings, transactions } = returnsAfterWritesInProject(join(root, 'tsconfig.json'), ours);
    // The scan reads the real transactions (it once read none and passed).
    expect(transactions).toBeGreaterThan(20);
    expect(findings).toEqual([]);
  }, 60_000);
});

describe('returnsAfterWrites', () => {
  it('finds a transaction inside a function, where every real one is', () => {
    expect(
      scan(`export async function convert(id) {
        try {
          return await db.transaction(async (tx) => {
            await tx.update(transactions).set({ amountCents: 1 });
            const inserted = await insertRow(tx);
            if ('error' in inserted) return inserted;
            return { ok: true };
          });
        } catch (err) { throw err; }
      }`),
    ).toEqual([6]);
  });

  it('finds the conversion bug: an error returned after an update', () => {
    expect(
      scan(`db.transaction(async (tx) => {
        await tx.update(transactions).set({ amountCents: 1 });
        const inserted = await insertRow(tx);
        if ('error' in inserted) return inserted;
        return { ok: true };
      });`),
    ).toEqual([4]);
    expect(scan(`db.transaction(async (tx) => { await tx.delete(t); return { error: 'no' }; });`)).toEqual([1]);
  });

  it('allows a refusal before any write, and a success after', () => {
    expect(
      scan(`db.transaction(async (tx) => {
        const [row] = await tx.select().from(t).for('update');
        if (!row) return { error: 'gone' };
        await tx.update(t).set({ a: 1 });
        return { ok: true, message: 'done' };
      });`),
    ).toEqual([]);
  });

  it('ignores a write in a branch that has already returned', () => {
    expect(
      scan(`db.transaction(async (tx) => {
        if (kind === 'new') {
          await tx.insert(t).values({});
          return { ok: true };
        }
        if (busy) return { error: 'busy' };
        await tx.update(t).set({});
        return { ok: true };
      });`),
    ).toEqual([]);
  });

  it('counts a write by a helper handed the transaction, and in an earlier loop pass', () => {
    expect(
      scan(`async function addRow(tx) { await tx.insert(t).values({}); }
      async function readRow(tx) { return tx.select().from(t); }
      db.transaction(async (tx) => {
        await readRow(tx);
        if (a) return { error: 'fine: only read so far' };
        await addRow(tx);
        if (b) return { error: 'after a write' };
        return { ok: true };
      });`),
    ).toEqual([7]);
    expect(
      scan(`db.transaction(async (tx) => {
        for (const x of xs) {
          if (bad(x)) return { error: 'an earlier pass wrote' };
          await tx.insert(t).values(x);
        }
      });`),
    ).toEqual([3]);
  });

  it('reads writes in raw SQL, and lets a throw through', () => {
    expect(scan('db.transaction(async (tx) => { await tx.execute(sql`update t set a = 1`); return { error: "x" }; });')).toEqual([1]);
    expect(scan('db.transaction(async (tx) => { await tx.execute(sql`select 1`); return { error: "x" }; });')).toEqual([]);
    expect(scan(`db.transaction(async (tx) => { await tx.update(t).set({}); if (x) throw new Refused('no'); return { ok: true }; });`)).toEqual([]);
  });
});
