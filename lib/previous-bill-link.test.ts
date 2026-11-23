import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SharedBill } from '../share/app/_components/shared-bill';
import type { BillSnapshot } from './bill-snapshot';

const snapshot: BillSnapshot = {
  personName: 'Alex', groupedByCategory: false, paper: 'classic', createdAt: new Date('2026-11-23'),
  owed: [], owing: [], owedCents: 50000, owingCents: 0, netCents: 50000,
  previousBalances: [{
    date: '2026-11-20', side: 'owed', token: 'prior-token', previous: 75000, payments: 25000,
    paymentDetails: [{ date: '2026-11-22', amount: 25000 }], adjustments: 0, omitted: 0, included: 50000, assigned: [],
  }],
};

test('previous bill links resolve to the bill site from both the private preview and the public receipt', () => {
  const render = (billBase: string | null, embedded: boolean) =>
    renderToStaticMarkup(createElement(SharedBill, { snapshot, billBase, embedded }));
  const viewer = 'https://bill.example';
  expect(render(viewer, true)).toContain('href="https://bill.example/s/prior-token"');
  expect(render('', false)).toContain('href="/s/prior-token"');
  expect(render(null, true)).not.toContain('View previous bill');
});
