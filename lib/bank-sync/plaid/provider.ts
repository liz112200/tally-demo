// BankProvider over Plaid. Maps Plaid's wire format onto the provider-neutral
// types in ../provider.ts; nothing Plaid-shaped escapes this file. This is one
// of the two places an access token is revealed: here, into a request body.
import { z } from 'zod';
import { parseDollars } from '../../money';
import { AccessToken } from '../access-token';
import {
  SyncBudgetExceededError,
  type BankProvider,
  type ProviderTransaction,
  type SyncFetch,
  type SyncReadiness,
} from '../provider';
import { createPlaidClient, PlaidApiError, type PlaidConfig } from './client';

// Shown in Plaid Link (30 characters at most).
const CLIENT_NAME = 'Tally';

// The full history Plaid allows. It is fixed when an Item is created and can
// never be raised afterwards, and an account's cutover may sit further back
// than the 90-day default (BANK-SYNC.md), so every Item asks for the maximum.
export const DAYS_REQUESTED = 730;

// The largest page /transactions/sync allows.
export const SYNC_PAGE_SIZE = 500;

// Restarts from the starting cursor after Plaid reports a mutation mid-
// pagination, before the fetch gives up.
export const MAX_SYNC_RESTARTS = 3;

const linkTokenSchema = z.object({
  link_token: z.string().min(1),
  expiration: z.string(),
});

const exchangeSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
});

const accountsGetSchema = z.object({
  item: z.object({
    item_id: z.string().min(1),
    institution_id: z.string().nullable().optional(),
    institution_name: z.string().nullable().optional(),
  }),
  accounts: z.array(
    z.object({
      account_id: z.string().min(1),
      persistent_account_id: z.string().nullable().optional(),
      name: z.string(),
      official_name: z.string().nullable(),
      mask: z.string().nullable(),
      type: z.string(),
      subtype: z.string().nullable(),
    }),
  ),
});

const itemGetSchema = z.object({
  item: z.object({
    item_id: z.string().min(1),
    institution_id: z.string().nullable().optional(),
    institution_name: z.string().nullable().optional(),
    error: z.object({ error_type: z.string(), error_code: z.string() }).loose().nullable().optional(),
    consent_expiration_time: z.string().nullable().optional(),
  }).loose(),
});

const itemRemoveSchema = z.object({ request_id: z.string().optional() });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Responses are parsed by parseJsonExact, so every JSON number arrives as its
// source text; `amount` is therefore a string here, converted exactly below.
const plaidTransactionSchema = z
  .object({
    transaction_id: z.string().min(1),
    account_id: z.string().min(1),
    amount: z.string(),
    iso_currency_code: z.string().nullable(),
    unofficial_currency_code: z.string().nullable(),
    date: isoDate,
    authorized_date: isoDate.nullable(),
    name: z.string().nullable().optional(),
    original_description: z.string().nullable().optional(),
    pending: z.boolean(),
    pending_transaction_id: z.string().nullable(),
  })
  .loose();

const syncPageSchema = z.object({
  added: z.array(plaidTransactionSchema),
  modified: z.array(plaidTransactionSchema),
  removed: z.array(z.object({ transaction_id: z.string().min(1), account_id: z.string().min(1) })),
  next_cursor: z.string(),
  has_more: z.boolean(),
  transactions_update_status: z.string().optional(),
});

type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;

function toProviderTransaction(t: PlaidTransaction): ProviderTransaction {
  let amountCents: number;
  try {
    amountCents = parseDollars(t.amount);
  } catch {
    throw new Error(`Transaction ${t.transaction_id} has an amount that is not an exact decimal: ${t.amount}`);
  }
  const description = (t.original_description ?? '').trim() || (t.name ?? '').trim();
  return {
    providerTransactionId: t.transaction_id,
    providerAccountId: t.account_id,
    // Plaid: positive = money out of the account, the canonical sign.
    amountCents,
    isoCurrencyCode: t.iso_currency_code,
    unofficialCurrencyCode: t.unofficial_currency_code,
    date: t.date,
    authorizedDate: t.authorized_date,
    descriptionRaw: description,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id,
    raw: t,
  };
}

function readiness(status: string | undefined): SyncReadiness {
  switch (status) {
    case 'NOT_READY':
      return 'not_ready';
    case 'INITIAL_UPDATE_COMPLETE':
      return 'initial';
    case 'HISTORICAL_UPDATE_COMPLETE':
      return 'historical';
    default:
      return 'unknown';
  }
}

export function createPlaidProvider(config: PlaidConfig): BankProvider {
  const client = createPlaidClient(config);
  const now = () => Date.now();
  const linkBase = (clientUserId: string) => ({
    client_name: CLIENT_NAME,
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: clientUserId },
    ...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}),
  });

  return {
    name: 'plaid',

    async createLinkToken({ clientUserId }) {
      const res = await client.post(
        '/link/token/create',
        {
          ...linkBase(clientUserId),
          products: ['transactions'],
          transactions: { days_requested: DAYS_REQUESTED },
        },
        linkTokenSchema,
      );
      return { linkToken: res.link_token, expiration: res.expiration };
    },

    // Update mode: the Item's access token instead of products. Plaid's rule
    // is to send no products and no product parameters here, so the Item's
    // transaction history request stays as it was set at creation.
    async createUpdateLinkToken(accessToken, { clientUserId, accountSelection }) {
      const res = await client.post(
        '/link/token/create',
        {
          ...linkBase(clientUserId),
          access_token: accessToken.reveal(),
          ...(accountSelection ? { update: { account_selection_enabled: true } } : {}),
        },
        linkTokenSchema,
      );
      return { linkToken: res.link_token, expiration: res.expiration };
    },

    async getItem(accessToken) {
      const res = await client.post('/item/get', { access_token: accessToken.reveal() }, itemGetSchema);
      return {
        itemId: res.item.item_id,
        institutionId: res.item.institution_id ?? null,
        institutionName: res.item.institution_name ?? null,
        errorCode: res.item.error?.error_code ?? null,
        consentExpiresAt: res.item.consent_expiration_time ?? null,
      };
    },

    async removeItem(accessToken) {
      await client.post('/item/remove', { access_token: accessToken.reveal() }, itemRemoveSchema);
    },

    async exchangePublicToken(publicToken) {
      const res = await client.post(
        '/item/public_token/exchange',
        { public_token: publicToken },
        exchangeSchema,
      );
      return { itemId: res.item_id, accessToken: new AccessToken(res.access_token) };
    },

    async getAccounts(accessToken) {
      const res = await client.post(
        '/accounts/get',
        { access_token: accessToken.reveal() },
        accountsGetSchema,
      );
      return {
        itemId: res.item.item_id,
        institutionId: res.item.institution_id ?? null,
        institutionName: res.item.institution_name ?? null,
        accounts: res.accounts.map((a) => ({
          providerAccountId: a.account_id,
          persistentAccountId: a.persistent_account_id ?? null,
          name: a.name,
          officialName: a.official_name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
        })),
      };
    },

    // Fetch every page for one account before anything is applied. Plaid
    // requires a restart from the starting cursor if the data changes mid-
    // pagination, so partial pages are discarded on restart, never kept.
    async syncTransactions(accessToken, { providerAccountId, cursor, deadline }) {
      const started = now();
      let pages = 0;
      for (let restarts = 0; ; restarts++) {
        const added: PlaidTransaction[] = [];
        const modified: PlaidTransaction[] = [];
        const removed: { transaction_id: string; account_id: string }[] = [];
        let pageCursor = cursor;
        try {
          for (;;) {
            if (deadline !== undefined && now() > deadline) {
              throw new SyncBudgetExceededError(pages, now() - started);
            }
            const page = await client.post(
              '/transactions/sync',
              {
                access_token: accessToken.reveal(),
                ...(pageCursor ? { cursor: pageCursor } : {}),
                count: SYNC_PAGE_SIZE,
                options: { include_original_description: true, account_id: providerAccountId },
              },
              syncPageSchema,
            );
            pages++;
            added.push(...page.added);
            modified.push(...page.modified);
            removed.push(...page.removed);
            // Plaid returns an empty cursor while the account's data is not
            // ready; nothing has been delivered and the stored cursor stays.
            if (page.next_cursor === '') {
              return emptyFetch(readiness(page.transactions_update_status), pages, restarts, now() - started);
            }
            pageCursor = page.next_cursor;
            if (!page.has_more) {
              const result: SyncFetch = {
                added: added.map(toProviderTransaction),
                modified: modified.map(toProviderTransaction),
                removed: removed.map((r) => ({
                  providerTransactionId: r.transaction_id,
                  providerAccountId: r.account_id,
                })),
                nextCursor: pageCursor,
                readiness: readiness(page.transactions_update_status),
                pages,
                restarts,
                ms: now() - started,
              };
              return result;
            }
          }
        } catch (err) {
          const mutated =
            err instanceof PlaidApiError &&
            err.errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
          if (!mutated || restarts >= MAX_SYNC_RESTARTS) throw err;
        }
      }
    },
  };
}

function emptyFetch(readiness: SyncReadiness, pages: number, restarts: number, ms: number): SyncFetch {
  return { added: [], modified: [], removed: [], nextCursor: null, readiness, pages, restarts, ms };
}
