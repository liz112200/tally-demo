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
  const receipt = preview.locator('.shared-check');
  await expect(receipt.getByRole('heading', { name: 'New entries' })).toBeVisible();
  await expect(receipt.locator('.previous-bills')).toHaveCSS('border-top-style', 'dashed');
  await expect(receipt.locator('dt').filter({ hasText: 'Payment from you' }).first()).toBeVisible();
  await expect(receipt.getByText('Item-specific payments')).toHaveCount(0);
  const previousHref = await receipt.getByRole('link', { name: 'View previous bill' }).getAttribute('href');
  expect(previousHref).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);
  expect((await page.request.get(previousHref!)).ok()).toBe(true);
  await carry.getByRole('button', { name: 'Exclude all' }).click();
  await expect(total).toHaveText(freshTotal);
  await expect(preview.locator('.shared-check')).not.toContainText('From earlier bills');
  await page.setViewportSize({ width: 375, height: 812 });
  await carry.getByText(/Compare items/).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a chosen partial payment survives publication and an earlier link can be turned off', async ({ page }) => {
  async function openPerson() {
    await page.goto('/people');
    await page.getByRole('button', { name: /Jordan/, expanded: false }).click();
  }
  async function publish() {
    await page.getByRole('button', { name: 'Create link' }).click();
    const href = await page.getByRole('link', { name: 'Open bill' }).getAttribute('href');
    expect(href).toMatch(/^\/s\//);
    return href!;
  }
  await openPerson();
  await page.getByRole('link', { name: 'Create bill' }).click();
  const previous = await publish();

  await openPerson();
  await page.getByRole('button', { name: /Pick shares/ }).click();
  const picker = page.getByRole('dialog');
  await picker.locator('#alloc-date').fill('2025-04-03');
  const apply = picker.getByRole('textbox', { name: /^Apply to / }).all();
  let entered = false;
  for (const field of await apply) {
    if (Number((await field.getAttribute('placeholder'))?.replaceAll(',', '')) > 1) {
      await field.fill('1.00');
      await field.blur();
      entered = true;
      break;
    }
  }
  expect(entered).toBe(true);
  await picker.getByRole('button', { name: /Record payment/ }).click();
  await expect(picker).toBeHidden();

  await page.getByRole('link', { name: 'Create bill' }).click();
  await page.getByRole('button', { name: 'Include all' }).first().click();
  const current = await publish();
  await page.goto(current);
  const carry = page.locator('.previous-bills');
  await expect(carry.getByText('Item-specific payments', { exact:true })).toBeVisible();
  await expect(carry.locator('time[datetime="2025-04-03"]').locator('..')).toHaveText('04/03Payment from you');
  await expect(carry).not.toContainText('What I paid');
  await expect(carry).toContainText('$1.00 paid');
  await expect(carry.getByRole('link', { name:'View previous bill' }).first()).toHaveAttribute('href', previous);

  await page.goto('/people/shared-bills');
  const row = page.getByRole('listitem').filter({has:page.locator(`a[href="${previous}"]`)});
  await row.getByRole('button', { name:'Turn off link' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name:'Turn off link' }).click();
  await expect(row).toHaveCount(0);
  await page.goto(current);
  await expect(page.locator('.previous-bills')).toContainText('$1.00 paid');
  await expect(page.locator(`a[href="${previous}"]`)).toHaveCount(0);
});

test('reviews an older receipt once and keeps its matched expenses out of new items', async ({ page }) => {
  await page.goto('/people');
  await page.getByRole('button', { name: /Priya/, expanded: false }).click();
  await page.getByRole('link', { name: 'Create bill' }).click();
  const review = page.getByRole('region', { name: 'Older bill matches' });
  await expect(review.getByText('Card purchase')).toBeVisible();
  await expect(review.getByRole('combobox')).toHaveCount(0);
  const total = page.locator('.review-preview .bill-proof strong');
  const initialTotal = await total.innerText();
  const same = review.getByRole('button', { name: 'Same purchase', exact: true }).first();
  await review.getByRole('button', { name: 'Different purchase', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved as different purchases' })).toBeVisible();
  await expect(total).toHaveText(initialTotal);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(same).toBeVisible();
  await same.click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved as the same purchase' })).toBeVisible();
  await page.reload();
  await expect(review).toHaveCount(0);
  const prior = page.locator('.review-section').filter({ has: page.getByRole('heading', { name: 'From the previous bill' }) });
  await prior.getByText(/Compare items/).click();
  await expect(prior.getByRole('checkbox')).toHaveCount(2);
  await expect(prior.getByRole('checkbox').first()).not.toBeChecked();
  await expect(prior.getByRole('checkbox').last()).not.toBeChecked();

  const decisions = page.locator('details').filter({ has: page.getByText(/^Past decisions/) });
  const entry = decisions.locator('div.border-t').filter({ hasText: 'Card purchase' });
  await decisions.locator('summary').click();
  await entry.getByRole('button', { name: 'Mark as different' }).click();
  await expect(entry.getByText('Marked as different', { exact: true })).toBeVisible();
  await expect(total).toHaveText(initialTotal);
  await page.reload();
  await decisions.locator('summary').click();
  await entry.getByRole('button', { name: 'Same purchase' }).first().click();
  await expect(entry.getByRole('button', { name: 'Mark as different' })).toBeVisible();
  await expect(total).toHaveText(initialTotal);
});
