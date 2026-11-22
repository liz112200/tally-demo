import { expect, test } from '@playwright/test';

test('review keeps the earlier balance optional and previews just the selected expenses', async ({ page }) => {
  await page.goto('/people');
  await page.getByRole('button', { name: /Alex/, expanded: false }).click();
  await page.getByRole('link', { name: 'Create bill' }).click();
  const previous = page.locator('.review-section').filter({ has: page.getByRole('combobox', { name: 'Previous bill' }) });
  await expect(previous.getByText(/Payments received/)).toBeVisible();
  await expect(previous.getByText(/Settled items/)).toBeVisible();
  const carry = page.locator('.review-section').filter({ has: page.getByRole('heading', { name: 'From the previous bill' }) });
  const preview = page.locator('.review-preview');
  const total = preview.locator('.bill-proof strong');
  const freshTotal = await total.innerText();
  await carry.getByRole('button', { name: 'Include all' }).click();
  await expect(total).not.toHaveText(freshTotal);
  await preview.getByText(/Full preview/).click();
  await expect(preview.locator('.shared-check')).toContainText('From earlier bills');
  await expect(preview.locator('.shared-check')).toContainText('paid since');
  await carry.getByRole('button', { name: 'Exclude all' }).click();
  await expect(total).toHaveText(freshTotal);
  await expect(preview.locator('.shared-check')).not.toContainText('From earlier bills');
  await page.setViewportSize({ width: 375, height: 812 });
  await carry.getByText(/Compare items/).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
