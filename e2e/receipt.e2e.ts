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
  await expect(page.getByText('Item split saved.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Expense detail' }).click();
  await page.getByRole('link', { name: 'Split by item' }).click();
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  // Restore the shared starter assignment for the phone check and the local demo.
  await page.getByRole('button', { name: /Garlic bread/ }).click();
  await bread.getByRole('button', { name: 'Both' }).click();
  await preview.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByText('Item split saved.', { exact: true })).toBeVisible();
});
