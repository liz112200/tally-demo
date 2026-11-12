// The release checklists as checks (E2E.md), run in order against a freshly
// reset local demo. Each step is one the owner used to do by hand; what is
// left to the owner is what reads well, not what is there.
import { expect, test, type Page } from '@playwright/test';
import { accounts, band, bandViewsMatch, rows, setImportsHidden, settled, statements } from './band';

test.describe.configure({ mode: 'serial' });

let ids: Record<string, string>;
const result = (page: Page, text: string | RegExp) => expect(page.getByText(text).first()).toBeVisible();

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  ids = await accounts(page);
  await page.close();
  // The demo's three accounts, by name: a check against fewer would pass
  // without having looked.
  expect(Object.keys(ids).sort()).toEqual(['Amex', 'Chase checking', 'Discover']);
});

test('the board: each card carries its statement count, and the band lines open what they count', async ({ page }) => {
  await settled(page, '/');
  for (const card of await page.locator('a[href^="/accounts/"]:has(div.text-xl)').all()) {
    await expect(card).toContainText(/closes .+\d+ statements?/);
  }
  const lines = await band(page);
  // The seed's own items (ACCOUNTS-BOARD.md, The demo): at least three.
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(await bandViewsMatch(page)).toBeGreaterThanOrEqual(1);
});

test('a raised row in a hidden import is still shown by the band’s Raised rows', async ({ page }) => {
  const raised = (await band(page)).find((l) => l.text.startsWith('Raised rows'));
  expect(raised, 'the demo opens with a raised row').toBeTruthy();
  const compare = (await band(page)).find((l) => l.action === 'Compare' && l.text.startsWith('Amex'));
  expect(compare, 'the demo opens with an Amex statement difference').toBeTruthy();
  expect(await setImportsHidden(page, ids.Amex, true)).toBeGreaterThan(0);
  // Its count is unchanged, and the view still shows every row it counts.
  expect((await band(page)).find((l) => l.text.startsWith('Raised rows'))?.text).toBe(raised!.text);
  await bandViewsMatch(page);
  await settled(page, raised!.href);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByText('This row is in a hidden import, shown here because the band asks about it. The import stays hidden.', { exact: true })).toBeVisible();
  // Browsing leaves hidden rows out of the list and the summary, and says so.
  await settled(page, '/expenses');
  await expect(page.getByText(/^\d+ rows? not shown or counted here: (it is|they are) in (a hidden import|\d+ hidden imports)\.$/)).toBeVisible();
  // On the account's page they still count in the figures: the statement
  // comparison does not move, and the period says they are counted.
  expect((await band(page)).find((l) => l.action === 'Compare' && l.text.startsWith('Amex'))?.text).toBe(compare!.text);
  await settled(page, `/accounts/${ids.Amex}`);
  await expect(page.getByText(/\d+ rows? not listed here, still counted in these figures: (it is|they are) in a hidden import/).first()).toBeVisible();
  await setImportsHidden(page, ids.Amex, false);
});

test('a point-out rule writes no category and its line shows every row it counts, hidden imports included', async ({ page }) => {
  await settled(page, '/settings');
  await page.locator('#add-category-name').fill('Settling up');
  await page.getByRole('checkbox', { name: 'Counts as spending' }).click();
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.locator('#add-category option, select option', { hasText: 'Settling up' }).first()).toBeAttached();

  await page.locator('#add-pattern').fill('ZELLE PAYMENT');
  await page.locator('#add-category').selectOption({ label: 'Settling up' });
  await page.locator('#add-mode').selectOption('point_out');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await result(page, 'Rule ZELLE PAYMENT added. It sets no category: rows it matches that have none are pointed out on the home page.');

  const line = async () => (await band(page)).find((l) => l.text.includes('"ZELLE PAYMENT"'));
  const first = await line();
  expect(first?.text).toMatch(/^Settling up: \d+ rows match your "ZELLE PAYMENT" rule and have no category\.$/);
  expect(first?.action).toBe('Sort');
  const counted = Number(first!.text.match(/(\d+) rows/)![1]);
  // Uncategorized Zelle rows, found by the filters rather than the rule: the
  // same rows. Categorized ones exist and are left alone.
  const uncategorized = '/expenses?q=zelle+payment&catsrc=uncategorized';
  await settled(page, uncategorized);
  await expect(rows(page)).toHaveCount(counted);
  await settled(page, '/expenses?q=zelle+payment');
  expect(await rows(page).count()).toBeGreaterThan(counted);
  await bandViewsMatch(page);

  // Its rows' imports hidden: the count stays, Sort still shows them all and
  // says how many came from hidden imports, the same number the filtered
  // browse says it leaves out.
  expect(await setImportsHidden(page, ids['Chase checking'], true)).toBeGreaterThan(0);
  expect((await line())?.text).toBe(first!.text);
  await settled(page, uncategorized);
  const notShown = page.getByText(/^(\d+) rows? not shown or counted here: (it is|they are) in/);
  await expect(notShown).toBeVisible();
  const held = Number((await notShown.innerText()).match(/^(\d+)/)![1]);
  expect(held).toBeGreaterThan(0);
  await settled(page, first!.href);
  await expect(rows(page)).toHaveCount(counted);
  const subject = held === counted ? (held === 1 ? 'This row is' : `All ${held} rows are`) : held === 1 ? '1 of these rows is' : `${held} of these rows are`;
  await expect(page.getByText(new RegExp(`^${subject} in (a hidden import|\\d+ hidden imports), shown here because the band asks about (it|them)\\. (The import stays|The imports stay) hidden\\.$`))).toBeVisible();

  // Apply to existing writes no category with it.
  await settled(page, '/settings');
  await page.getByRole('button', { name: 'Apply to existing' }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /apply/i });
  if (await confirm.count()) await confirm.click();
  await expect(page.getByRole('button', { name: 'Apply to existing' })).toBeEnabled();
  expect((await line())?.text).toBe(first!.text);
  await settled(page, uncategorized);
  await expect(page.getByText(new RegExp(`^${held} rows? not shown or counted here`))).toBeVisible();
  await setImportsHidden(page, ids['Chase checking'], false);
  await settled(page, uncategorized);
  await expect(rows(page)).toHaveCount(counted);
});

test('a recorded statement is edited in place, and Add totals lands on its form', async ({ page }) => {
  const before = await statements(page, ids.Discover);
  const latest = before[0];
  expect(latest.totals && !latest.fromCheck, `Discover's latest statement is recorded by hand with totals: ${latest.text}`).toBe(true);

  // Edit: the form is prefilled, and a blank total is cleared.
  const li = page.locator('#statements details > ul > li', { hasText: latest.closing }).first();
  await li.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = li.locator('div.rounded-lg', { hasText: `Statement closing ${latest.closing}` });
  const charges = form.locator('input[id^="edit-charges-"]');
  const credits = form.locator('input[id^="edit-credits-"]');
  const [was1, was2] = [await charges.inputValue(), await credits.inputValue()];
  expect(was1).toMatch(/^\d[\d,]*\.\d{2,3}$/);
  await charges.fill('');
  await credits.fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await result(page, `Statement closing ${latest.closing} updated.`);
  const after = await statements(page, ids.Discover);
  expect(after.length).toBe(before.length);
  expect(after[0]).toMatchObject({ closing: latest.closing, totals: false });

  // The band asks for its totals, and its action opens that statement's form.
  const ask = (await band(page)).find((l) => l.action === 'Add totals');
  expect(ask?.text).toMatch(/^Discover: the .+ statement has no totals recorded/);
  expect(ask?.href).toBe(`/accounts/${ids.Discover}?statement=${latest.closing}#statements`);
  await page.locator('section[aria-labelledby="needs-you"] a', { hasText: 'Add totals' }).click();
  const opened = page.locator('#statements div.rounded-lg', { hasText: `Statement closing ${latest.closing}` });
  await expect(opened).toBeVisible();
  await expect(opened.locator('input[id^="edit-charges-"]')).toHaveValue('');
  await opened.locator('input[id^="edit-charges-"]').fill(was1);
  await opened.locator('input[id^="edit-credits-"]').fill(was2);
  await opened.getByRole('button', { name: 'Save' }).click();
  await result(page, `Statement closing ${latest.closing} updated.`);
  // The band's address is dropped, so a reload does not reopen the form.
  await expect(page).not.toHaveURL(/statement=/);
  expect((await statements(page, ids.Discover))[0].text).toBe(latest.text);
  expect((await band(page)).some((l) => l.action === 'Add totals')).toBe(false);

  // Recording the same closing date again is refused and changes nothing.
  await settled(page, `/accounts/${ids.Discover}`);
  await page.getByRole('button', { name: 'Record a statement' }).click();
  await page.locator(`#closing-${ids.Discover}`).fill(latest.closing);
  await page.locator(`#charges-${ids.Discover}`).fill('1.00');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await result(page, `A statement closing ${latest.closing} is already recorded. Use Edit beside it in the list to change it.`);
  expect((await statements(page, ids.Discover))[0].text).toBe(latest.text);
});

test('a statement from a statement check offers its period and totals as text, not inputs', async ({ page }) => {
  const check = (await statements(page, ids.Amex)).find((s) => s.fromCheck);
  expect(check, 'the demo has an Amex statement from a check').toBeTruthy();
  const li = page.locator('#statements details > ul > li', { hasText: check!.closing }).first();
  await li.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = li.locator('div.rounded-lg', { hasText: `Statement closing ${check!.closing}` });
  await expect(form.getByText(/^From a statement check: its period \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\) and totals \(\$[\d,.]+ \/ \$[\d,.]+\) matched the rows to the cent, so they are not edited here\.$/)).toBeVisible();
  await expect(form.locator('input[id^="edit-charges-"], input[id^="edit-credits-"], input[id^="edit-start-"]')).toHaveCount(0);
  await expect(form.locator('input[id^="edit-next-"]')).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
});

test('Record it lands on the form that records a statement', async ({ page }) => {
  const [latest] = await statements(page, ids.Discover);
  const li = page.locator('#statements details > ul > li', { hasText: latest.closing }).first();
  await li.getByRole('button', { name: 'Remove', exact: true }).click();
  await result(page, `Statement closing ${latest.closing} removed.`);

  const ask = (await band(page)).find((l) => l.action === 'Record it');
  expect(ask?.text).toMatch(/^Discover: a statement has closed since the one of .+ and is not recorded\.$/);
  expect(ask?.href).toBe(`/accounts/${ids.Discover}?record=statement#statements`);
  await page.locator('section[aria-labelledby="needs-you"] a', { hasText: 'Record it' }).click();
  await expect(page.locator(`#closing-${ids.Discover}`)).toBeVisible();

  // Recorded back as it was.
  const [charges, credits] = latest.text.match(/\$[\d,]+\.\d{2,3}/g)!.map((s) => s.slice(1));
  await page.locator(`#closing-${ids.Discover}`).fill(latest.closing);
  await page.locator(`#start-${ids.Discover}`).fill(latest.start!);
  await page.locator(`#charges-${ids.Discover}`).fill(charges);
  await page.locator(`#credits-${ids.Discover}`).fill(credits);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await result(page, `Statement closing ${latest.closing} recorded.`);
  await expect(page).not.toHaveURL(/record=/);
  expect((await statements(page, ids.Discover))[0].text).toBe(latest.text);
  expect((await band(page)).some((l) => l.action === 'Record it')).toBe(false);
});

test('a difference is accepted only with a typed reason', async ({ page }) => {
  const differs = (await band(page)).find((l) => l.action === 'Compare');
  expect(differs, 'the demo opens with a statement difference').toBeTruthy();
  await settled(page, differs!.href);
  const accept = page.getByRole('button', { name: 'Accept this difference' }).first();
  await expect(accept).toBeDisabled();
  const note = page.locator('textarea').first();
  await note.fill('   ');
  await expect(accept).toBeDisabled();
  await note.fill('Checked against the statement');
  await expect(accept).toBeEnabled();
});
