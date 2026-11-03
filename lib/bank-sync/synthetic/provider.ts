// The demo's bank provider (DEMO-SYNC.md): the second implementation of
// BankProvider, so the demo's bank rows go through the real sync code. Pure
// and deterministic. Each account's feed is fixed by the demo seed for one
// reset day (lib/demo/seed.ts): the delivery the reset already applied, then
// one delivery per Sync now press, then nothing.
//
// A synthetic token opens nothing: it is a fixed, non-secret value naming its
// login, stored unsealed, and only demo mode ever constructs this provider or
// opens a synthetic connection (lib/bank-sync/select-provider.ts). Linking,
// update mode and removal are refused here as the demo's actions refuse them.
import type { AccessToken } from '../access-token';
import type {
  BankProvider,
  ItemAccounts,
  ItemStatus,
  ProviderAccount,
  ProviderTransaction,
  RemovedTransaction,
  SyncFetch,
} from '../provider';

export type SyntheticDelivery = {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: RemovedTransaction[];
};

// One account's sync history for a reset day.
export type SyntheticFeed = {
  // Everything up to the reset, which the seed itself applied.
  seeded: SyntheticDelivery;
  // One per Sync now press, in order.
  presses: SyntheticDelivery[];
};

export type SyntheticItem = {
  itemId: string;
  institutionId: string;
  institutionName: string;
  accounts: (ProviderAccount & { feed: SyntheticFeed })[];
};

export const NOT_IN_DEMO = 'Not available in the demo: the demo has no real bank to link to.';

// The stored token of a synthetic login. Not a secret.
export function syntheticToken(itemId: string): string {
  return `synthetic:${itemId}`;
}

// The cursor after the seeded delivery and `presses` presses, for one reset
// day. A cursor from another day is refused, as Plaid refuses a foreign one.
export function syntheticCursor(day: string, presses: number): string {
  return `v1:${day}:${presses}`;
}

function parseCursor(cursor: string, day: string): number {
  const match = /^v1:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(cursor);
  if (!match || match[1] !== day) {
    throw new Error('The demo bank does not recognize this sync position; reset the demo to start again.');
  }
  return Number(match[2]);
}

export function createSyntheticProvider(input: { day: string; items: readonly SyntheticItem[] }): BankProvider {
  const itemOf = (accessToken: AccessToken): SyntheticItem => {
    const item = input.items.find((i) => syntheticToken(i.itemId) === accessToken.reveal());
    if (!item) throw new Error('The demo bank does not know this login.');
    return item;
  };

  return {
    name: 'synthetic',
    async createLinkToken() {
      throw new Error(NOT_IN_DEMO);
    },
    async createUpdateLinkToken() {
      throw new Error(NOT_IN_DEMO);
    },
    async exchangePublicToken() {
      throw new Error(NOT_IN_DEMO);
    },
    async removeItem() {
      throw new Error(NOT_IN_DEMO);
    },
    async getItem(accessToken): Promise<ItemStatus> {
      const item = itemOf(accessToken);
      return { itemId: item.itemId, institutionId: item.institutionId, institutionName: item.institutionName, errorCode: null, consentExpiresAt: null };
    },
    async getAccounts(accessToken): Promise<ItemAccounts> {
      const item = itemOf(accessToken);
      return {
        itemId: item.itemId,
        institutionId: item.institutionId,
        institutionName: item.institutionName,
        accounts: item.accounts.map(({ feed: _feed, ...account }) => account),
      };
    },
    async syncTransactions(accessToken, { providerAccountId, cursor }): Promise<SyncFetch> {
      const account = itemOf(accessToken).accounts.find((a) => a.providerAccountId === providerAccountId);
      if (!account) throw new Error('The demo bank does not know this account.');
      const { seeded, presses } = account.feed;
      const done = cursor === null ? -1 : parseCursor(cursor, input.day);
      const delivery: SyntheticDelivery =
        done === -1 ? seeded : done < presses.length ? presses[done] : { added: [], modified: [], removed: [] };
      return {
        ...delivery,
        nextCursor: syntheticCursor(input.day, Math.min(done + 1, presses.length)),
        readiness: 'historical',
        pages: 1,
        restarts: 0,
        ms: 0,
      };
    },
  };
}
