import { defineConfig, devices } from '@playwright/test';

// Release checks in a browser (E2E.md), against the local demo only: they
// change its data, so they never run against the public demo or production.
// `npm run e2e` (scripts/e2e-local.sh) builds the commit under test in the
// local demo's worktree, resets the local demo, and serves it here; the
// suite refuses any other address.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(baseURL)) {
  throw new Error(`Refusing to run the release checks against ${baseURL}: they change data, and run against the local demo only.`);
}
const serverDir = process.env.E2E_SERVER_DIR;
const port = new URL(baseURL).port;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // One worker, in order: the checks build on each other's changes to the
  // ledger, as the owner's checklists did.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  // A check loads a dozen pages; on a loaded machine (2026-11-12) one took
  // over a minute.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', testIgnore: '**/phone.e2e.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    // Layout at a phone's width, after the desktop checks; whether it reads
    // well on a real phone stays the owner's.
    { name: 'phone', testMatch: '**/phone.e2e.ts', dependencies: ['desktop'], use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  // Served from the worktree holding the commit under test, never an
  // already-running server, which could be any build. Five minutes to answer:
  // on a loaded machine (2026-11-12) the first page took over two.
  webServer: serverDir
    ? { command: `npx next start -p ${port}`, cwd: serverDir, url: baseURL, reuseExistingServer: false, timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
    : undefined,
});
