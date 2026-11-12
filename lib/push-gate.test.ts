import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The push gate (E2E.md, .githooks/pre-push): a push to master is refused
// unless the browser checks passed on exactly the commit pushed. The checks
// cannot run in CI, so without this they would rest on a promise to run them.

const ROOT = join(__dirname, '..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('the push gate', () => {
  let repo: string;
  let first: string;
  let second: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'push-gate-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'gate@example.test');
    git(repo, 'config', 'user.name', 'Gate');
    writeFileSync(join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    first = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'two');
    git(repo, 'commit', '-q', '-am', 'two');
    second = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'hooks'));
    copyFileSync(join(ROOT, '.githooks/pre-push'), join(repo, 'hooks/pre-push'));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const push = (sha: string, ref = 'refs/heads/master') =>
    spawnSync('bash', ['hooks/pre-push', 'origin', 'git@example.test:x.git'], {
      cwd: repo,
      input: `refs/heads/release ${sha} ${ref} ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
    });
  const record = (sha: string | null) => {
    const path = join(repo, '.git/e2e-passed');
    if (sha === null) rmSync(path, { force: true });
    else writeFileSync(path, `${sha}\n2026-11-12T00:00:00Z\n`);
  };

  it('refuses a push to master with no passing run recorded', () => {
    record(null);
    const r = push(second);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Push refused: the browser checks have not passed on');
    expect(r.stderr).toContain('No passing run is recorded.');
  });

  it('refuses a commit other than the one that passed, naming both', () => {
    record(first);
    const r = push(second);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not passed on [0-9a-f]+ two/);
    expect(r.stderr).toMatch(/Last passing run: [0-9a-f]+ one \(2026-11-12T00:00:00Z\)/);
  });

  it('lets through the commit that passed, other branches, and a deletion', () => {
    record(second);
    expect(push(second).status).toBe(0);
    record(first);
    expect(push(second, 'refs/heads/release-3').status).toBe(0);
    expect(push('0'.repeat(40)).status).toBe(0);
  });

  it('is installed in this checkout, so it runs', () => {
    // Outside a git checkout (the snapshot's test copy) there is no push to gate.
    const inside = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
    if (inside.status !== 0 || inside.stdout.trim() !== ROOT) return;
    expect(git(ROOT, 'config', '--get', 'core.hooksPath')).toBe('.githooks');
  });
});
