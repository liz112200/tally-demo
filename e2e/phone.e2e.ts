// At a phone's width (390px): nothing scrolls sideways, and the controls the
// release added fit. Whether they read well on a real phone is the owner's.
import { expect, test, type Page } from '@playwright/test';
import { accounts, settled } from './band';

const noSideScroll = async (page: Page, where: string) => {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${where} scrolls sideways (${scroll}px wide in ${width}px)`).toBeLessThanOrEqual(width);
};

test('the home page, every account page and Expenses fit a phone', async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
  const ids = await accounts(page);
  expect(Object.keys(ids).length).toBe(3);
  await settled(page, '/');
  await noSideScroll(page, 'Home');
  for (const li of await page.locator('section[aria-labelledby="needs-you"] li').all()) {
    const box = (await li.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  for (const [name, id] of Object.entries(ids)) {
    await settled(page, `/accounts/${id}`);
    await noSideScroll(page, name);
  }
  await settled(page, '/expenses');
  await noSideScroll(page, 'Expenses');
});

test('a statement’s edit form fits a phone', async ({ page }) => {
  const ids = await accounts(page);
  await settled(page, `/accounts/${ids.Discover}`);
  await page.locator('#statements summary').click();
  await page.locator('#statements details > ul > li').first().getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('#statements div.rounded-lg', { hasText: 'Statement closing' });
  await expect(form).toBeVisible();
  const box = (await form.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await noSideScroll(page, 'The statement edit form');
});
