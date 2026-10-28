// The action-results convention (ACTION-RESULTS.md, CLAUDE.md), enforced
// structurally: every function exported from a 'use server' file in
// app/_actions declares its return type, and none returns nothing. A caller
// cannot tell the owner what an action did if the action does not say.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'app/_actions');

function exportedActions(file: string): { name: string; returnType: string | null }[] {
  const source = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const first = source.statements[0];
  const isServer =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server';
  if (!isServer) return [];
  const out: { name: string; returnType: string | null }[] = [];
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    out.push({ name: statement.name.text, returnType: statement.type ? statement.type.getText(source) : null });
  }
  return out;
}

describe('Server Actions', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const actions = files.flatMap((f) => exportedActions(f).map((a) => ({ file: f, ...a })));

  it('are found (the test reads the right files)', () => {
    expect(actions.length).toBeGreaterThan(40);
  });

  it('each declare a return type and never return nothing', () => {
    const offenders = actions
      .filter((a) => a.returnType === null || /\bvoid\b|\bundefined\b/.test(a.returnType))
      .map((a) => `${a.file}: ${a.name} returns ${a.returnType ?? '(undeclared)'}`);
    expect(offenders).toEqual([]);
  });
});

// A count of ledger rows says "row" (ACTION-RESULTS.md): one dialog counting
// "transactions" beside a group header counting "rows" read as two numbers.
describe('Counts', () => {
  const files = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(root, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(root, e.name)] : [],
    );

  it('say "row", never "transaction"', () => {
    const count = /\$\{[^}]+\} transactions?\b|\$\{[^}]+\} transaction\$\{/;
    const offenders = files(join(process.cwd(), 'app')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (count.test(line) ? [`${file.slice(process.cwd().length + 1)}:${i + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
