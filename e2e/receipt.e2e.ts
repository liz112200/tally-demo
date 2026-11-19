import { expect, test } from '@playwright/test';

test('sample and transaction share the Ledger editor and bulk assignments persist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Split a sample dinner' }).click();
  const drawer = page.getByRole('dialog', { name: 'Dinner at Alba' });
  const method = drawer.getByLabel('Split method');
  await expect(method).toHaveValue('item');
  const bounds = (await drawer.boundingBox())!;
  expect(bounds.y).toBe(0);
  expect(bounds.x + bounds.width).toBe(page.viewportSize()!.width);
  const bread = drawer.getByRole('group', { name: 'Assign Garlic bread', exact: true });
  const preview = drawer.getByRole('region', { name: 'Split preview' });
  await expect(preview.locator('[aria-live]')).toContainText('$26.00');
  await bread.getByRole('button', { name: /^Everyone/ }).click();
  await bread.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(drawer.getByText('Everyone except Alex')).toBeVisible();
  await drawer.getByRole('button', { name: 'Apply to all items' }).click();
  await expect(drawer.getByText('Everyone except Alex', { exact: true })).toHaveCount(3);
  await drawer.getByRole('button', { name: 'Undo' }).click();
  await expect(drawer.getByText('Everyone except Alex', { exact: true })).toHaveCount(1);
  await bread.getByRole('button', { name: 'Meal group (2)' }).click();
  await expect(preview.locator('[aria-live]')).toContainText('$26.00');
  await bread.getByRole('button', { name: 'Same as previous' }).click();
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  await method.selectOption('percent');
  await expect(drawer.getByRole('group', { name: 'Participants' })).toBeVisible();
  await method.selectOption('item');
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  await preview.getByRole('button', { name: 'Save split' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/split=item/);
  await expect(page.getByRole('link', { name: 'View balances', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit split', exact: true }).click();
  await expect(method).toHaveValue('item');
  await expect(preview.locator('[aria-live]')).toContainText('$30.00');
  // No dish is shared on reopen, so the first item starts expanded.
  await drawer.getByRole('button', { name: /Garlic bread/ }).click();
  await bread.getByRole('button', { name: 'You', exact: true }).click();
  await preview.getByRole('button', { name: 'Save split' }).click();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('link', { name: 'View balances', exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
});

test('the ordinary split uses the same drawer and Escape returns to the ledger', async ({ page }) => {
  await page.goto('/expenses');
  await page.getByRole('button', { name: /^Split / }).filter({ hasText: 'Split' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Split method')).toHaveValue('equal');
  const people = dialog.getByRole('group', { name: 'Participants' });
  const checkboxes = people.getByRole('checkbox');
  // The seeded default may already include everyone.
  if (await people.getByRole('button', { name: 'Clear selection' }).count())
    await people.getByRole('button', { name: 'Clear selection' }).click();
  await people.getByRole('button', { name: 'Select everyone' }).click();
  await expect(people.getByRole('checkbox', { checked: true })).toHaveCount(await checkboxes.count());
  await dialog.getByLabel('Split method').selectOption('amount');
  await checkboxes.first().uncheck();
  await people.getByRole('button', { name: 'Select everyone' }).click();
  await dialog.getByLabel('Split method').selectOption('percent');
  await people.getByRole('button', { name: 'Clear selection' }).click();
  await expect(people.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save split' })).toBeDisabled();
  await expect(dialog.getByRole('group', { name: 'Participants' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
