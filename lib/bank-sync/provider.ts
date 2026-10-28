// The bank-data provider as the rest of the app sees it (BANK-SYNC.md). Plaid
// is one implementation; the demo's synthetic provider will be the second, so
// nothing outside an implementation may depend on Plaid's wire format.
//
// Methods arrive with the slice that needs them: slice 1 links an Item and
// lists its accounts; slice 2 adds transaction sync; slice 4 adds the Item's
// health, update mode and removal.
import type { AccessToken } from './access-token';

export const BANK_PROVIDERS = ['plaid'] as const;
export type BankProviderName = (typeof BANK_PROVIDERS)[number];

export type LinkToken = {
  linkToken: string;
  // ISO 8601; a new-Item token lasts four hours.
  expiration: string;
};

export type ExchangedItem = {
  // The provider's id for the bank login (a Plaid Item). Stable for the life
  // of the connection.
  itemId: string;
  // Full read access to the login's accounts, as an opaque value. Sealed
  // before it is stored (lib/token-crypto.ts) and never sent to the browser.
  accessToken: AccessToken;
};

export type ProviderAccount = {
  providerAccountId: string;
  // Stable across re-links at institutions that tokenize account numbers
  // (Chase, PNC, US Bank), where providerAccountId can change. Null elsewhere.
  persistentAccountId: string | null;
  name: string;
  officialName: string | null;
  // Last 2-4 characters of the account number; not unique within a login.
  mask: string | null;
  type: string;
  subtype: string | null;
};

export type ItemAccounts = {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  accounts: ProviderAccount[];
};

// A login's state at the provider.
export type ItemStatus = {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  // The provider's error code for the login, or null when it is healthy.
  // lib/bank-sync/item-health.ts says what each means to the owner.
  errorCode: string | null;
  // ISO 8601, when the institution ends the login's consent; null if never.
  consentExpiresAt: string | null;
};

export interface BankProvider {
  readonly name: BankProviderName;
  // A short-lived token that opens the provider's link UI for a new login.
  createLinkToken(input: { clientUserId: string }): Promise<LinkToken>;
  // The same, for an existing login (Plaid's update mode): signs it in again,
  // renews consent, or with accountSelection changes which accounts it
  // shares. Never creates a login, and the access token does not change.
  createUpdateLinkToken(
    accessToken: AccessToken,
    input: { clientUserId: string; accountSelection: boolean },
  ): Promise<LinkToken>;
  getItem(accessToken: AccessToken): Promise<ItemStatus>;
  // End the provider's access to the login. Irreversible, and on Plaid's
  // Trial plan the Item's slot is not returned.
  removeItem(accessToken: AccessToken): Promise<void>;
  // Trade the one-time public token the link UI returns for durable access.
  exchangePublicToken(publicToken: string): Promise<ExchangedItem>;
  getAccounts(accessToken: AccessToken): Promise<ItemAccounts>;
  // Every change to one account since `cursor` (null = its full history),
  // all pages fetched. See SyncFetchOptions for the time budget.
  syncTransactions(
    accessToken: AccessToken,
    input: { providerAccountId: string; cursor: string | null } & SyncFetchOptions,
  ): Promise<SyncFetch>;
}

export type SyncFetchOptions = {
  // Epoch ms after which no further page is requested; the fetch fails with
  // SyncBudgetExceededError instead of running into the function timeout.
  deadline?: number;
};

export class SyncBudgetExceededError extends Error {
  constructor(pages: number, ms: number) {
    super(`Sync stopped after ${pages} page(s) and ${Math.round(ms / 1000)}s: over its time budget.`);
    this.name = 'SyncBudgetExceededError';
  }
}

// One transaction as the provider reported it, in provider-neutral terms.
export type ProviderTransaction = {
  providerTransactionId: string;
  providerAccountId: string;
  // Integer mills, canonical sign (spending positive), converted from the
  // provider's exact decimal text; never a float.
  amountCents: number;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  // ISO dates. `date` is the posted date for posted rows; `authorizedDate` is
  // when the purchase happened, when known.
  date: string;
  authorizedDate: string | null;
  // The bank's own description when the provider has it (what the
  // categorization rules were tuned on), else the provider's name.
  descriptionRaw: string;
  pending: boolean;
  pendingTransactionId: string | null;
  // The provider's object as received (numbers as their source text), kept
  // for debugging and for later slices' date and category logic.
  raw: unknown;
};

export type RemovedTransaction = {
  providerTransactionId: string;
  providerAccountId: string;
};

// The provider's readiness for an account's history.
export type SyncReadiness = 'not_ready' | 'initial' | 'historical' | 'unknown';

export type SyncFetch = {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: RemovedTransaction[];
  // Where the next sync resumes. Null when the provider has nothing ready
  // yet; the stored cursor must not move then.
  nextCursor: string | null;
  readiness: SyncReadiness;
  pages: number;
  restarts: number;
  ms: number;
};
