// Nothing moves after a page loads (2026-11-12: the demo's tips strip
// appeared after load and pushed the band and cards down, the first thing a
// stranger sees), and the strip is rendered by the server in its final state,
// dismissed or not.
import { expect, test, type Page } from '@playwright/test';
import { accounts, settled } from './band';

// The layout shift the browser recorded once the server's page had fully
// arrived, without shifts caused by input. Before that, a page arriving
// slowly is painted as it comes, and a long table re-lays out as its rows
// arrive (2026-11-12, at a load average over 100); that is the server being
// slow, not the page moving after it loaded, which is what this checks.
const shifted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const arrived = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseEnd;
        let total = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
            if (!e.hadRecentInput && e.startTime >= arrived) total += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(total), 500);
      }),
  );

test('pages do not move after they load, first visit or not', async ({ page, context }) => {
  const ids = await accounts(page);
  const paths = ['/', `/accounts/${ids.Amex}`, '/expenses'];
  for (const dismissed of [false, true]) {
    await context.clearCookies();
    if (dismissed) await context.addCookies([{ name: 'demo-orientation-dismissed', value: '1', url: page.url() }]);
    for (const path of paths) {
      await settled(page, path);
      expect(await shifted(page), `${path} moved after loading${dismissed ? ' (tips dismissed)' : ''}`).toBeLessThan(0.01);
    }
  }
});

test('the tips strip is in the server’s page in its final state, and dismissing it lasts', async ({ page, context }) => {
  await context.clearCookies();
  // As sent by the server, before any script runs.
  const html = async () => (await page.request.get('/')).text();
  expect(await html()).toContain('More things to try');
  await settled(page, '/');
  await page.getByRole('button', { name: 'Dismiss' }).first().click();
  await expect(page.getByText('More things to try')).toHaveCount(0);
  expect(await html()).not.toContain('More things to try');
  await settled(page, '/');
  await expect(page.getByText('More things to try')).toHaveCount(0);
  // Brought back from the banner, for the next load too.
  await page.getByRole('button', { name: 'Things to try' }).click();
  await expect(page.getByText('More things to try')).toBeVisible();
  await settled(page, '/');
  await expect(page.getByText('More things to try')).toBeVisible();
});

test('demo palettes change the drawer and survive reload and light mode', async ({ page }) => {
  await page.goto('/settings#appearance');
  const palette = page.getByRole('button', { name: /Graphite/ });
  await palette.click();
  await expect(palette).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(palette).toHaveAttribute('aria-pressed', 'true');
  const background = () => page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await background()).toBe('rgb(23, 23, 25)');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  expect(await background()).toBe('rgb(243, 245, 245)');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.goto('/expenses/receipt/sample-dinner');
  const drawer = page.getByRole('dialog', { name: 'Dinner at Alba' });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(39, 39, 43)');
});

test('bank history is collapsed while next actions stay visible', async ({ page }) => {
  await page.goto('/accounts/logins');
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Review.*held row/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Verify statement/ })).toBeVisible();
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Connection details' }) }).first();
  await expect(details.getByText(/CSV history through/)).toBeHidden();
  await details.locator('summary').click();
  await expect(details.getByText(/CSV history through/)).toBeVisible();
});
