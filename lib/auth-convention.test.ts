// The authorization guarantee (AUTH.md, CLAUDE.md): every Server Action,
// page and route handler checks the session first. Enumerated from the
// filesystem, never from a list, so an action, page or route added later is
// checked the moment it exists. The only list is the short set of public
// entry points, and an entry there that no longer exists fails the test, so
// it cannot rot silently either. proxy.ts is not the guarantee: Next
// documents it as an optimistic check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isPublicPath } from './auth/session-token';

const root = process.cwd();

// Server Actions that run without a session: signing in creates one.
const PUBLIC_ACTIONS = ['beginSignIn', 'finishSignIn', 'beginBootstrap', 'finishBootstrap'];
// Pages reachable without a session, by file.
const PUBLIC_PAGES = ['app/sign-in/page.tsx', 'app/s/[token]/page.tsx'];

function walk(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, name));
    else if (entry === name) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
}

// The first statement of a function body, as source text.
function firstStatement(fn: ts.FunctionDeclaration, source: ts.SourceFile): string {
  return fn.body?.statements[0]?.getText(source) ?? '';
}

const callsRequireUser = (statement: string) => /^(const \w+ = )?await requireUser\(\);$/.test(statement);

function exportedFunctions(source: ts.SourceFile, { defaultOnly = false } = {}): ts.FunctionDeclaration[] {
  return source.statements.filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      (!defaultOnly || !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)),
  );
}

// "app/people/page.tsx" -> "/people"; "app/s/[token]/page.tsx" -> "/s/x".
function routePath(file: string): string {
  const segments = file.split('/').slice(1, -1).map((s) => (s.startsWith('[') ? 'x' : s));
  return `/${segments.join('/')}`;
}

describe('Server Actions', () => {
  const files = readdirSync(join(root, 'app/_actions'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `app/_actions/${f}`)
    .filter((f) => readFileSync(join(root, f), 'utf8').trimStart().startsWith("'use server'"));
  const actions = files.flatMap((f) => {
    const source = parse(f);
    return exportedFunctions(source).map((fn) => ({ file: f, name: fn.name!.text, first: firstStatement(fn, source) }));
  });

  it('are found', () => {
    expect(actions.length).toBeGreaterThan(50);
  });

  it('each check the session as their first statement, unless they are how one signs in', () => {
    const offenders = actions
      .filter((a) => !PUBLIC_ACTIONS.includes(a.name) && !callsRequireUser(a.first))
      .map((a) => `${a.file}: ${a.name} starts with: ${a.first.split('\n')[0]}`);
    expect(offenders).toEqual([]);
  });

  it('the public list names only actions that exist, and they do not check a session', () => {
    const names = actions.map((a) => a.name);
    expect(PUBLIC_ACTIONS.filter((n) => !names.includes(n))).toEqual([]);
  });
});

describe('pages', () => {
  const pages = walk(join(root, 'app'), 'page.tsx');

  it('are found', () => {
    expect(pages).toEqual(expect.arrayContaining(['app/page.tsx', 'app/people/page.tsx', 'app/accounts/page.tsx']));
  });

  it('each check the session as their first statement, unless public', () => {
    const offenders = pages
      .filter((p) => !PUBLIC_PAGES.includes(p))
      .flatMap((p) => {
        const source = parse(p);
        const [page] = exportedFunctions(source, { defaultOnly: true });
        return page && callsRequireUser(firstStatement(page, source)) ? [] : [p];
      });
    expect(offenders).toEqual([]);
  });

  it('are public exactly when proxy.ts lets them through without a session', () => {
    expect(PUBLIC_PAGES.filter((p) => !pages.includes(p))).toEqual([]);
    const mismatched = pages.filter((p) => isPublicPath(routePath(p)) !== PUBLIC_PAGES.includes(p));
    expect(mismatched).toEqual([]);
  });
});

describe('route handlers', () => {
  const routes = walk(join(root, 'app'), 'route.ts');

  it('each check the session, the cron secret, or demo mode as their first statement', () => {
    const offenders = routes.flatMap((r) => {
      const source = parse(r);
      return exportedFunctions(source)
        .filter((fn) => {
          const first = firstStatement(fn, source);
          if (r.startsWith('app/api/demo/')) return !first.startsWith('if (!isDemoMode())');
          if (r.startsWith('app/api/cron/')) return !first.includes('isCronRequest(');
          return !callsRequireUser(first);
        })
        .map((fn) => `${r}: ${fn.name?.text}`);
    });
    expect(offenders).toEqual([]);
  });
});
