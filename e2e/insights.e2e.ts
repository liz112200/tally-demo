import { expect, test } from '@playwright/test';
import { parseDollars } from '../lib/money';

test('spending views carry through months and category expenses reconcile to the report', async ({ page }) => {
  await page.goto('/insights');
  const views = page.getByRole('navigation', { name: 'Spending view' });
  await expect(views.getByRole('link', { name: 'What I paid' })).toHaveAttribute('aria-current', 'page');
  await views.getByRole('link', { name: 'My share' }).click();
  await expect(views.getByRole('link', { name: 'My share' })).toHaveAttribute('aria-current', 'page');
  const previous = page.getByRole('link', { name: 'Previous month' });
  const previousUrl = new URL((await previous.getAttribute('href'))!, page.url());
  await previous.click();
  await expect(page).toHaveURL(previousUrl.href);
  await page.reload();
  await expect(views.getByRole('link', { name: 'My share' })).toHaveAttribute('aria-current', 'page');
  const categories = page.locator('.expense-categories details');
  expect(await categories.count()).toBeGreaterThan(1);
  let reportTotal = 0;
  for (const category of await categories.all()) {
    const summary = category.locator('summary');
    await summary.click();
    await expect(category.locator('ul')).toBeVisible();
    const lines = await category.locator('li > b').allTextContents();
    expect(lines.length).toBeGreaterThan(0);
    const subtotal = lines.reduce((sum, text) => sum + parseDollars(text), 0);
    expect(subtotal).toBe(parseDollars(await summary.locator('b').innerText()));
    reportTotal += subtotal;
  }
  expect(parseDollars(await page.locator('.report-head strong').innerText())).toBe(reportTotal);
  await views.getByRole('link', { name: 'What I paid' }).click();
  await expect(views.getByRole('link', { name: 'What I paid' })).toHaveAttribute('aria-current', 'page');
});
