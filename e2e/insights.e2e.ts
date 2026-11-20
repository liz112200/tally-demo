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

test('an expense Alex paid appears in the chosen My share category', async ({ page }) => {
  const description = 'Dinner with Alex (category check)';
  async function openAlex() {
    await page.goto('/people');
    await page.getByRole('button', { name: /Alex/, expanded: false }).click();
  }

  await openAlex();
  await page.getByRole('button', { name: 'Log expense Alex paid' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount you owe Alex').fill('12.34');
  await dialog.getByLabel('Description').fill(description);
  const month = (await dialog.getByLabel('Date', { exact: true }).inputValue()).slice(0, 7);
  const picker = dialog.getByLabel('Category', { exact: true });
  await expect(picker.locator('option:checked')).toHaveText('Uncategorized');
  await expect(picker.getByRole('option', { name: 'Groceries' })).toBeAttached();
  await picker.selectOption({ label: 'Dining' });
  await dialog.getByRole('button', { name: 'Log expense', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/insights?view=share&month=${month}`);
  await page.locator('.expense-categories summary').filter({ hasText: 'Dining' }).click();
  const line = page.getByRole('list', { name: 'Dining expenses' }).getByRole('listitem').filter({ hasText: description });
  await expect(line).toContainText('Paid by Alex');
  await expect(line.locator('b')).toHaveText('$12.34');
  await page.getByRole('link', { name: 'What I paid' }).click();
  await expect(page.getByRole('link', { name: 'What I paid' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.expense-categories li').filter({ hasText: description })).toHaveCount(0);

  await openAlex();
  await page.getByRole('button', { name: `Delete expense "${description}" for $12.34` }).click();
  await page.getByRole('button', { name: 'Delete expense', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
