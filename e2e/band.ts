// Shared steps for the release checks (E2E.md): reading the band, the
// accounts, and the rows a view shows. Everything is read from the page;
// nothing here knows the demo's figures, which change with the day.
import { expect, type Page } from '@playwright/test';

export type BandLine = { kind: string; text: string; action: string; href: string };

export async function band(page: Page): Promise<BandLine[]> {
  await settled(page, '/');
  const out = await page.locator('section[aria-labelledby="needs-you"] li').evaluateAll((lis) =>
    lis.map((li) => {
      const link = li.querySelector('a');
      return {
        kind: li.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '',
        text: (li.querySelector('span.flex-1') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        action: link?.textContent?.trim() ?? '',
        href: link?.getAttribute('href') ?? '',
      };
    }),
  );
  // The heading's count is the lines below it.
  if (out.length > 0) await expect(page.locator('#needs-you')).toHaveText(`Needs you · ${out.length}`);
  return out;
}

// A page loaded. The demo's tips strip used to appear after load and move
// everything below it, and a list read item by item while it appeared skipped
// the last card (2026-11-12); the strip is now rendered by the server and
// layout.e2e.ts fails if a page moves after loading, so a loaded page is a
// settled one. Lists are still read in one pass. The short wait for the
// network to go quiet is a courtesy to hydration's prefetches, not a
// condition: under heavy load (2026-11-12) it never resolved on a page whose
// network had been quiet for twenty seconds, which Playwright warns of.
export async function settled(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

// The ledger account ids, by the name on each card.
export async function accounts(page: Page): Promise<Record<string, string>> {
  await settled(page, '/');
  const cards = await page.locator('a[href^="/accounts/"]:has(div.text-xl)').evaluateAll((as) =>
    as.map((a) => [a.querySelector('div.text-xl')?.textContent?.trim() ?? '', a.getAttribute('href') ?? ''] as const),
  );
  const ids: Record<string, string> = {};
  for (const [name, href] of cards) {
    const m = href.match(/^\/accounts\/([0-9a-f-]{36})$/);
    if (m) ids[name] = m[1];
  }
  return ids;
}

export const rows = (page: Page) => page.locator('tr[id^="tx-"]');

// Every band line that opens Expenses shows exactly the rows it counts
// (2026-11-11: the band counted rows its own link could not show).
export async function bandViewsMatch(page: Page): Promise<number> {
  const lines = (await band(page)).filter((l) => l.href.startsWith('/expenses'));
  for (const line of lines) {
    const counted = Number(line.text.match(/(\d+) rows?\b/)?.[1]);
    expect(counted, `a count in "${line.text}"`).toBeGreaterThan(0);
    await settled(page, line.href);
    await expect(rows(page), `rows shown by "${line.text}"`).toHaveCount(counted);
  }
  return lines.length;
}

export async function setImportsHidden(page: Page, ledgerId: string, hidden: boolean): Promise<number> {
  await settled(page, `/accounts/${ledgerId}`);
  const button = page.locator('#imports li').getByRole('button', { name: hidden ? 'Hide' : 'Show', exact: true });
  const n = await button.count();
  for (let i = 0; i < n; i++) {
    await button.first().click();
    await expect(button).toHaveCount(n - i - 1);
  }
  await expect(page.locator('#imports li', { hasText: 'hidden from Expenses' })).toHaveCount(hidden ? n : 0);
  return n;
}

// The statements recorded for an account, newest first, as listed. Loaded
// without a fragment: going to the page's own address plus #statements is a
// jump within the page, not a load, and would read the list as it was.
export async function statements(page: Page, ledgerId: string) {
  await settled(page, `/accounts/${ledgerId}`);
  const summary = page.locator('#statements summary');
  if ((await summary.count()) === 0) return [];
  const details = page.locator('#statements details');
  if ((await details.getAttribute('open')) === null) await summary.click();
  const texts = await page.locator('#statements details > ul > li').evaluateAll((lis) => lis.map((li) => (li as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
  return texts.map((text) => {
    const dates = text.match(/^(?:(\d{4}-\d{2}-\d{2}) – )?(\d{4}-\d{2}-\d{2})/)!;
    return { closing: dates[2], start: dates[1] ?? null, text, fromCheck: text.includes('from a statement check'), totals: !text.includes('no totals') };
  });
}
