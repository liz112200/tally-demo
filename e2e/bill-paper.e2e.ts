import { expect, test } from '@playwright/test';

test('the recipient opens the paper chosen in People in light and dark', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/people');
  await page.getByRole('button', { name: /Alex/, expanded: false }).click();
  await page.getByRole('button', { name: 'Bill style' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose bill paper' });
  for (const [name, paper] of [['Wildflowers', 'flowers'], ['Paw prints', 'paws']]) {
    await picker.getByRole('radio', { name }).check();
    await expect(picker.locator('.bill-proof')).toHaveAttribute('data-paper', paper);
  }
  await picker.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
  const url = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(url.search).toBe('');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(url.pathname + url.search);
    await expect(page.getByRole('heading', { name: 'Our tab, Alex' })).toBeVisible();
    await expect(page.locator('.shared-check')).toHaveAttribute('data-paper', 'paws');
    await expect(page.locator('.shared-check section').first()).toContainText(/What (I|you) paid/);
  }
  await page.goto(url.pathname + '?paper=flowers');
  await expect(page.locator('.shared-check')).toHaveAttribute('data-paper', 'paws');
  await expect(page.getByRole('heading', { name: 'Our tab, Alex' })).toBeVisible();
});
