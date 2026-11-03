import { describe, expect, it } from 'vitest';
import { AccessToken } from '../access-token';
import type { ProviderTransaction } from '../provider';
import { NOT_IN_DEMO, createSyntheticProvider, syntheticCursor, syntheticToken, type SyntheticItem } from './provider';

const txn = (id: string): ProviderTransaction => ({
  providerTransactionId: id,
  providerAccountId: 'acct',
  amountCents: 12_340,
  isoCurrencyCode: 'USD',
  unofficialCurrencyCode: null,
  date: '2026-11-01',
  authorizedDate: '2026-11-01',
  descriptionRaw: `ROW ${id}`,
  pending: false,
  pendingTransactionId: null,
  raw: {},
});

const item: SyntheticItem = {
  itemId: 'item-a',
  institutionId: 'ins_a',
  institutionName: 'Example (demo)',
  accounts: [
    {
      providerAccountId: 'acct', persistentAccountId: null, name: 'Card', officialName: null, mask: '0001', type: 'credit', subtype: 'credit card',
      feed: {
        seeded: { added: [txn('h1'), txn('h2')], modified: [], removed: [] },
        presses: [
          { added: [txn('p1')], modified: [], removed: [] },
          { added: [], modified: [{ ...txn('h1'), amountCents: 15_840 }], removed: [] },
        ],
      },
    },
  ],
};
const provider = createSyntheticProvider({ day: '2026-11-02', items: [item] });
const token = new AccessToken(syntheticToken('item-a'));
const sync = (cursor: string | null) => provider.syncTransactions(token, { providerAccountId: 'acct', cursor });

describe('the synthetic provider', () => {
  it('serves the seeded history, then one delivery per press, then nothing', async () => {
    const first = await sync(null);
    expect(first.added.map((t) => t.providerTransactionId)).toEqual(['h1', 'h2']);
    expect(first.nextCursor).toBe(syntheticCursor('2026-11-02', 0));
    const press1 = await sync(first.nextCursor);
    expect(press1.added.map((t) => t.providerTransactionId)).toEqual(['p1']);
    const press2 = await sync(press1.nextCursor);
    expect(press2.modified.map((t) => t.amountCents)).toEqual([15_840]);
    const after = await sync(press2.nextCursor);
    expect(after).toMatchObject({ added: [], modified: [], removed: [], nextCursor: press2.nextCursor });
  });

  it('refuses a cursor from another reset day, and a token it did not issue', async () => {
    await expect(sync(syntheticCursor('2026-11-01', 0))).rejects.toThrow('reset the demo');
    await expect(provider.getItem(new AccessToken('synthetic:item-b'))).rejects.toThrow('does not know this login');
  });

  it('reports a healthy login with its accounts, and links nothing', async () => {
    expect(await provider.getItem(token)).toMatchObject({ itemId: 'item-a', errorCode: null });
    expect((await provider.getAccounts(token)).accounts).toEqual([
      { providerAccountId: 'acct', persistentAccountId: null, name: 'Card', officialName: null, mask: '0001', type: 'credit', subtype: 'credit card' },
    ]);
    await expect(provider.createLinkToken({ clientUserId: 'x' })).rejects.toThrow(NOT_IN_DEMO);
    await expect(provider.removeItem(token)).rejects.toThrow(NOT_IN_DEMO);
  });
});
