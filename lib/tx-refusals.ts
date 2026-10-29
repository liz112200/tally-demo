import ts from 'typescript';

// Finds every database transaction callback that returns a refusal after a
// write (CLAUDE.md, Architecture): inside db.transaction a return commits
// what was already written, so a refusal after the first write must throw.
// A conversion that returned its error after updating an amount committed
// the amount alone (dev, 2026-10-29); a rule in CLAUDE.md could be forgotten,
// so lib/tx-refusals.test.ts runs this over the source and fails the build.
//
// What counts as a write: a call to insert, update or delete on the
// transaction handle (`tx.update(...)`), `tx.execute(sql\`...\`)` whose SQL
// writes, and a call to a function of this codebase that is handed the
// handle and itself writes (found by name, to a fixpoint). What counts as a
// refusal: a returned value whose type can have an `error` property (with the
// project's type checker: `{ id } | { error }` can, a string id cannot); or,
// without a checker, an object literal with `error` or a bare identifier. A write precedes a return when it comes earlier in an enclosing
// block, except inside an `if` branch that always returns or throws, or
// anywhere in a loop that encloses the return (an earlier pass wrote).

export type Finding = { file: string; line: number; text: string };

const HANDLES = new Set(['tx', 'conn']);
const WRITE_METHODS = new Set(['insert', 'update', 'delete']);
const WRITE_SQL = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

// Every descendant of `node`, not entering nested functions (their bodies run
// elsewhere, not where they are written).
function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  node.forEachChild((child) => {
    visit(child);
    if (!isFunctionLike(child)) walk(child, visit);
  });
}

// Every descendant, nested functions included: a callback passed inside the
// transaction (items.map(async (x) => tx.insert(...))) runs during it.
function walkAll(node: ts.Node, visit: (n: ts.Node) => void) {
  node.forEachChild((child) => {
    visit(child);
    walkAll(child, visit);
  });
}

function templateText(t: ts.TemplateLiteral): string {
  return ts.isNoSubstitutionTemplateLiteral(t) ? t.text : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(' ');
}

// Snippets and single files, without type information.
export function returnsAfterWrites(sources: { file: string; text: string }[]): Finding[] {
  return analyse(sources.map((s) => ts.createSourceFile(s.file, s.text, ts.ScriptTarget.Latest, true)), null).findings;
}

// The project's own files, read through its tsconfig, with the type checker.
export function returnsAfterWritesInProject(
  tsconfigPath: string,
  include: (fileName: string) => boolean,
): { findings: Finding[]; transactions: number } {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, tsconfigPath.replace(/[^/]+$/, ''));
  const program = ts.createProgram(parsed.fileNames.filter(include), { ...parsed.options, noEmit: true });
  return analyse(program.getSourceFiles().filter((f) => include(f.fileName)), program.getTypeChecker());
}

function analyse(files: ts.SourceFile[], checker: ts.TypeChecker | null): { findings: Finding[]; transactions: number } {

  // Named functions of the codebase, and which of them write through a handle.
  const functions = new Map<string, ts.Node[]>();
  for (const sf of files) {
    walkAll(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) functions.set(n.name.text, [...(functions.get(n.name.text) ?? []), n.body]);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
        functions.set(n.name.text, [...(functions.get(n.name.text) ?? []), n.initializer.body]);
      }
    });
  }
  const writing = new Set<string>();
  const directWrite = (n: ts.Node): boolean => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && HANDLES.has(n.expression.expression.text)) {
      const method = n.expression.name.text;
      if (WRITE_METHODS.has(method)) return true;
      if (method === 'execute') {
        const arg = n.arguments[0];
        return !!arg && ts.isTaggedTemplateExpression(arg) && WRITE_SQL.test(templateText(arg.template));
      }
    }
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && HANDLES.has(n.tag.text)) return WRITE_SQL.test(templateText(n.template));
    return false;
  };
  const helperWrite = (n: ts.Node): boolean =>
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    writing.has(n.expression.text) &&
    n.arguments.some((a) => ts.isIdentifier(a) && HANDLES.has(a.text));
  const writes = (node: ts.Node): boolean => {
    if (directWrite(node) || helperWrite(node)) return true;
    let found = false;
    walkAll(node, (n) => {
      if (!found && (directWrite(n) || helperWrite(n))) found = true;
    });
    return found;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, bodies] of functions) {
      if (!writing.has(name) && bodies.some(writes)) {
        writing.add(name);
        changed = true;
      }
    }
  }

  const terminates = (s: ts.Statement): boolean => {
    if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
    if (ts.isBlock(s)) return s.statements.length > 0 && terminates(s.statements[s.statements.length - 1]);
    if (ts.isIfStatement(s)) return !!s.elseStatement && terminates(s.thenStatement) && terminates(s.elseStatement);
    return false;
  };
  // Whether a write in `s` can still have happened when control passes it.
  const writesFlowingOut = (s: ts.Statement): boolean => {
    if (ts.isIfStatement(s)) {
      return (
        writes(s.expression) ||
        (!terminates(s.thenStatement) && writes(s.thenStatement)) ||
        (!!s.elseStatement && !terminates(s.elseStatement) && writes(s.elseStatement))
      );
    }
    return writes(s);
  };
  const statementsOf = (n: ts.Node): readonly ts.Statement[] | null =>
    ts.isBlock(n) || ts.isSourceFile(n) ? n.statements : ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : null;
  const isLoop = (n: ts.Node) =>
    ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);

  const refusal = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    if (checker) {
      const type = checker.getTypeAtLocation(e);
      const members = type.isUnion() ? type.types : [type];
      return members.some((m) => m.getProperty('error') !== undefined);
    }
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
    if (ts.isIdentifier(x)) return x.text !== 'undefined';
    let found = false;
    const check = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n) && n.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'error')) found = true;
    };
    check(x);
    walk(x, check);
    return found;
  };

  const findings: Finding[] = [];
  let transactions = 0;
  for (const sf of files) {
    // Transactions sit inside functions, so every node is searched.
    walkAll(sf, (call) => {
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'transaction') return;
      const callback = call.arguments[0];
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
      const body = callback.body;
      transactions += 1;
      walk(body, (ret) => {
        if (!ts.isReturnStatement(ret) || !refusal(ret.expression)) return;
        let child: ts.Node = ret;
        let parent: ts.Node | undefined = ret.parent;
        let wrote = false;
        while (parent && child !== body && !wrote) {
          const statements = statementsOf(parent);
          if (statements) {
            for (const s of statements) {
              if (s === child) break;
              if (writesFlowingOut(s)) wrote = true;
            }
          }
          if (isLoop(parent) && writes(parent)) wrote = true;
          child = parent;
          parent = parent.parent;
        }
        if (wrote) {
          const { line } = sf.getLineAndCharacterOfPosition(ret.getStart());
          findings.push({ file: sf.fileName, line: line + 1, text: ret.getText().split('\n')[0] });
        }
      });
    });
  }
  return { findings, transactions };
}
