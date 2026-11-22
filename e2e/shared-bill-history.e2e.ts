import { expect, test } from '@playwright/test';

test('history reuses the original bill link and can turn off just that link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  async function createBill() {
    await page.goto('/people');
    await page.getByRole('button', { name: /Alex/, expanded: false }).click();
    await page.getByRole('link', { name: 'Create bill' }).click();
    const earlierItems = page.locator('section.review-section').filter({ has: page.getByRole('heading', { name: /From the previous bill|On other earlier bills/ }) });
    const group = earlierItems.first();
    await group.getByText(/Compare items/).click();
    const item = group.getByRole('checkbox').first();
    await expect(item).not.toBeChecked();
    await item.check();
    await expect(group.getByText('Last bill', { exact: true })).toBeVisible();
    await expect(group.getByText('Open now', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create link' }).click();
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
    return page.evaluate(() => navigator.clipboard.readText());
  }
  const earlier = await createBill();
  const original = await createBill();
  expect(original).not.toBe(earlier);

  await page.getByRole('link', { name: 'Shared bill history' }).click();
  const bills = page.getByRole('list', { name: 'Shared bills' });
  const latest = bills.getByRole('listitem').first();
  await expect(latest.getByRole('heading')).toHaveText('Alex');
  await expect(latest.getByRole('link', { name: 'Open bill' })).toHaveAttribute('href', new URL(original).pathname);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await latest.getByRole('button', { name: 'Copy link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  const totalBills = await bills.getByRole('listitem').count();

  await latest.getByRole('button', { name: 'Turn off link' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect((await page.request.get(original)).ok()).toBe(true);
  await latest.getByRole('button', { name: 'Turn off link' }).click();
  await confirm.getByRole('button', { name: 'Turn off link' }).click();
  await expect(latest.getByText('Link off', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(latest.getByRole('link', { name: 'Open bill' })).toHaveCount(0);
  await expect(bills.getByRole('listitem')).toHaveCount(totalBills);
  const recipient = await context.newPage();
  await recipient.goto(original);
  await expect(recipient.getByRole('heading', { name: 'Our tab, Alex' })).toHaveCount(0);
  await expect(recipient.getByText('404', { exact: true })).toBeVisible();
  await recipient.goto(earlier);
  await expect(recipient.getByRole('heading', { name: 'Our tab, Alex' })).toBeVisible();
});
