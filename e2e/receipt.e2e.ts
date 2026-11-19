import { expect, test } from '@playwright/test';

test('the dinner link opens the receipt, explains a reassignment, and saves it to Expenses', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Split a sample dinner' }).click();
  await expect(page.getByRole('heading', { name: 'Dinner at Alba' })).toBeVisible();
  const preview = page.getByRole('region', { name: 'Split preview' });
  const bread = page.getByRole('group', { name: 'Assign Garlic bread', exact: true });
  await expect(bread.getByRole('button', { name: 'Both' })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.locator('[aria-live]')).toContainText('$26.00');
  await bread.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  const alex = preview.locator('details').filter({ has: page.locator('summary', { hasText: 'Alex’s share' }) });
  await alex.locator('summary').click();
  await expect(alex.getByText('Rigatoni + Garlic bread')).toBeVisible();
  await expect(alex.getByText('$24.00', { exact: true })).toBeVisible();
  await expect(alex.getByText('$6.00', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByRole('heading', { name: 'Split saved' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save split' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Try bank sync' })).toHaveAttribute('href', '/accounts/logins');
  const expenseUrl = await page.getByRole('link', { name: 'View expense' }).getAttribute('href');
  expect(expenseUrl).toMatch(/^\/expenses\?tx=/);
  await page.getByRole('link', { name: 'View balances' }).click();
  await expect(page).toHaveURL(/\/people\?person=/);
  await page.goto(expenseUrl!);
  await page.getByRole('link', { name: 'Split by item' }).click();
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  // Restore the shared starter assignment for the phone check and the local demo.
  await page.getByRole('button', { name: /Garlic bread/ }).click();
  await bread.getByRole('button', { name: 'Both' }).click();
  await preview.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByRole('heading', { name: 'Split saved' })).toBeFocused();
  await page.getByRole('link', { name: 'Back to expense' }).click();
  await expect(page.getByRole('link', { name: 'Split by item' })).toBeVisible();
});

test('a visitor can close the sample dinner before saving', async ({ page }) => {
  await page.goto('/expenses/receipt/sample-dinner');
  await page.getByRole('link', { name: 'Back to demo', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'Split a sample dinner' })).toBeVisible();
});
