import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PlaidApiError, plaidConfigFromEnv, PLAID_API_VERSION } from './client';
import { createPlaidProvider, DAYS_REQUESTED } from './provider';
import { AccessToken } from '../access-token';

// Synthetic responses in Plaid's wire shape. Never paste real responses here:
// this file is published in the public snapshot.
type Call = { url: string; init: RequestInit };

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const CONFIG = { clientId: 'client-id-test', secret: 'secret-test', env: 'sandbox' as const };

const ACCOUNTS_BODY = {
  item: { item_id: 'item-1', institution_id: 'ins_109508', institution_name: 'First Platypus Bank' },
  accounts: [
    {
      account_id: 'acc-checking',
      persistent_account_id: null,
      name: 'Plaid Checking',
      official_name: 'Plaid Gold Standard 0% Interest Checking',
      mask: '0000',
      type: 'depository',
      subtype: 'checking',
      balances: { current: 110, available: 100, iso_currency_code: 'USD' },
    },
    {
      account_id: 'acc-card',
      name: 'Plaid Credit Card',
      official_name: null,
      mask: '3333',
      type: 'credit',
      subtype: 'credit card',
    },
  ],
  request_id: 'req-1',
};

describe('plaidConfigFromEnv', () => {
  it('reads a complete configuration', () => {
    expect(
      plaidConfigFromEnv({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'sandbox' }),
    ).toEqual({ clientId: 'c', secret: 's', env: 'sandbox' });
  });

  it('names what is missing without echoing values', () => {
    expect(() => plaidConfigFromEnv({ PLAID_SECRET: 'hunter2' })).toThrow(
      /PLAID_CLIENT_ID, PLAID_ENV not set/,
    );
    expect(() => plaidConfigFromEnv({ PLAID_SECRET: 'hunter2' })).not.toThrow(/hunter2/);
  });

  it('passes a redirect URI through exactly, and only when set', () => {
    const base = { PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'sandbox' };
    expect(plaidConfigFromEnv({ ...base, PLAID_REDIRECT_URI: 'http://localhost:3000/accounts/oauth' }).redirectUri).toBe(
      'http://localhost:3000/accounts/oauth',
    );
    expect('redirectUri' in plaidConfigFromEnv(base)).toBe(false);
    expect('redirectUri' in plaidConfigFromEnv({ ...base, PLAID_REDIRECT_URI: '' })).toBe(false);
  });

  it('refuses a redirect URI Plaid would refuse', () => {
    const base = { PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's' };
    expect(() =>
      plaidConfigFromEnv({ ...base, PLAID_ENV: 'production', PLAID_REDIRECT_URI: 'http://localhost:3000/accounts/oauth' }),
    ).toThrow(/must be https/);
    expect(() =>
      plaidConfigFromEnv({ ...base, PLAID_ENV: 'sandbox', PLAID_REDIRECT_URI: 'http://example.com/accounts/oauth' }),
    ).toThrow(/must be https/);
    expect(() =>
      plaidConfigFromEnv({ ...base, PLAID_ENV: 'sandbox', PLAID_REDIRECT_URI: 'https://app.example.com/accounts/oauth#x' }),
    ).toThrow(/fragment/);
    expect(() => plaidConfigFromEnv({ ...base, PLAID_ENV: 'sandbox', PLAID_REDIRECT_URI: 'accounts/oauth' })).toThrow(
      /not a URL/,
    );
  });

  it('rejects an unknown environment', () => {
    expect(() =>
      plaidConfigFromEnv({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'development' }),
    ).toThrow(/sandbox" or "production/);
  });
});

describe('Plaid requests', () => {
  it('sends credentials in headers, never in the body', async () => {
    const { impl, calls } = fakeFetch([{ body: { link_token: 'link-sandbox-1', expiration: '2026-10-19T22:00:00Z' } }]);
    await createPlaidProvider({ ...CONFIG, fetch: impl }).createLinkToken({ clientUserId: 'owner-1' });

    const [{ url, init }] = calls;
    expect(url).toBe('https://sandbox.plaid.com/link/token/create');
    const headers = init.headers as Record<string, string>;
    expect(headers['PLAID-CLIENT-ID']).toBe('client-id-test');
    expect(headers['PLAID-SECRET']).toBe('secret-test');
    expect(headers['Plaid-Version']).toBe(PLAID_API_VERSION);
    expect(String(init.body)).not.toContain('secret-test');
  });

  it('targets the production host in production', async () => {
    const { impl, calls } = fakeFetch([{ body: { access_token: 'a', item_id: 'i' } }]);
    await createPlaidProvider({ ...CONFIG, env: 'production', fetch: impl }).exchangePublicToken('p');
    expect(calls[0].url).toBe('https://production.plaid.com/item/public_token/exchange');
  });
});

describe('createLinkToken', () => {
  it('asks for transactions with the full history, which cannot be raised later', async () => {
    const { impl, calls } = fakeFetch([{ body: { link_token: 'link-sandbox-1', expiration: '2026-10-19T22:00:00Z' } }]);
    const token = await createPlaidProvider({ ...CONFIG, fetch: impl }).createLinkToken({ clientUserId: 'owner-1' });

    expect(token).toEqual({ linkToken: 'link-sandbox-1', expiration: '2026-10-19T22:00:00Z' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      products: ['transactions'],
      country_codes: ['US'],
      user: { client_user_id: 'owner-1' },
      transactions: { days_requested: 730 },
    });
    expect(DAYS_REQUESTED).toBe(730);
  });
});

describe('redirect URI on link tokens', () => {
  it('is sent on new-login and update tokens when configured, and absent otherwise', async () => {
    const res = { body: { link_token: 'link-sandbox-1', expiration: '2026-10-19T22:00:00Z' } };
    const withUri = fakeFetch([res, res]);
    const p = createPlaidProvider({ ...CONFIG, redirectUri: 'http://localhost:3000/accounts/oauth', fetch: withUri.impl });
    await p.createLinkToken({ clientUserId: 'owner-1' });
    await p.createUpdateLinkToken(new AccessToken('access-sandbox-1'), { clientUserId: 'owner-1', accountSelection: false });
    for (const call of withUri.calls) {
      expect(JSON.parse(String(call.init.body)).redirect_uri).toBe('http://localhost:3000/accounts/oauth');
    }
    const without = fakeFetch([res]);
    await createPlaidProvider({ ...CONFIG, fetch: without.impl }).createLinkToken({ clientUserId: 'owner-1' });
    expect('redirect_uri' in JSON.parse(String(without.calls[0].init.body))).toBe(false);
  });
});

describe('createUpdateLinkToken', () => {
  const res = { body: { link_token: 'link-sandbox-update', expiration: '2026-10-19T22:30:00Z' } };

  it('opens the existing Item: its access token, and no products or product parameters', async () => {
    const { impl, calls } = fakeFetch([res]);
    const token = await createPlaidProvider({ ...CONFIG, fetch: impl }).createUpdateLinkToken(
      new AccessToken('access-sandbox-1'),
      { clientUserId: 'owner-1', accountSelection: false },
    );
    expect(token).toEqual({ linkToken: 'link-sandbox-update', expiration: '2026-10-19T22:30:00Z' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(body).toMatchObject({ access_token: 'access-sandbox-1', user: { client_user_id: 'owner-1' }, country_codes: ['US'] });
    expect(body).not.toHaveProperty('products');
    expect(body).not.toHaveProperty('transactions');
    expect(body).not.toHaveProperty('update');
  });

  it('turns on account selection only when asked', async () => {
    const { impl, calls } = fakeFetch([res]);
    await createPlaidProvider({ ...CONFIG, fetch: impl }).createUpdateLinkToken(new AccessToken('a'), {
      clientUserId: 'owner-1',
      accountSelection: true,
    });
    expect(JSON.parse(String(calls[0].init.body)).update).toEqual({ account_selection_enabled: true });
  });
});

describe('getItem', () => {
  it('reads a healthy Item', async () => {
    const { impl, calls } = fakeFetch([
      {
        body: {
          item: {
            item_id: 'item-1',
            institution_id: 'ins_109508',
            institution_name: 'First Platypus Bank',
            error: null,
            consent_expiration_time: null,
            update_type: 'background',
            products: ['transactions'],
          },
          status: { transactions: { last_successful_update: '2026-10-26T10:00:00Z', last_failed_update: null } },
          request_id: 'r',
        },
      },
    ]);
    expect(await createPlaidProvider({ ...CONFIG, fetch: impl }).getItem(new AccessToken('access-sandbox-1'))).toEqual({
      itemId: 'item-1',
      institutionId: 'ins_109508',
      institutionName: 'First Platypus Bank',
      errorCode: null,
      consentExpiresAt: null,
    });
    expect(calls[0].url).toBe('https://sandbox.plaid.com/item/get');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ access_token: 'access-sandbox-1' });
  });

  it('reads the error code and consent expiry of an Item that needs the owner', async () => {
    const { impl } = fakeFetch([
      {
        body: {
          item: {
            item_id: 'item-1',
            institution_id: 'ins_127287',
            error: {
              error_type: 'ITEM_ERROR',
              error_code: 'ITEM_LOGIN_REQUIRED',
              error_code_reason: null,
              error_message: 'the login details of this item have changed',
              display_message: null,
            },
            consent_expiration_time: '2027-01-20T00:00:00Z',
          },
          request_id: 'r',
        },
      },
    ]);
    expect(await createPlaidProvider({ ...CONFIG, fetch: impl }).getItem(new AccessToken('a'))).toEqual({
      itemId: 'item-1',
      institutionId: 'ins_127287',
      institutionName: null,
      errorCode: 'ITEM_LOGIN_REQUIRED',
      consentExpiresAt: '2027-01-20T00:00:00Z',
    });
  });
});

describe('getItem on recorded Sandbox responses', () => {
  // tests/fixtures/plaid/sandbox-item-health.json: Plaid's own bytes for
  // /item/get before and after /sandbox/item/reset_login.
  const recorded: { calls: { path: string; response: string }[] } = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/plaid/sandbox-item-health.json'), 'utf8'),
  );

  it('were recorded as /item/get, reset_login, /item/get on one Item', () => {
    expect(recorded.calls.map((c) => c.path)).toEqual(['/item/get', '/sandbox/item/reset_login', '/item/get']);
    const ids = [recorded.calls[0], recorded.calls[2]].map((c) => JSON.parse(c.response).item.item_id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reads the healthy Item, then ITEM_LOGIN_REQUIRED after the reset', async () => {
    const { impl } = fakeFetch([{ body: recorded.calls[0].response }, { body: recorded.calls[2].response }]);
    const provider = createPlaidProvider({ ...CONFIG, fetch: impl });
    const before = await provider.getItem(new AccessToken('a'));
    const after = await provider.getItem(new AccessToken('a'));
    expect(before).toMatchObject({ institutionId: 'ins_109508', institutionName: 'First Platypus Bank', errorCode: null, consentExpiresAt: null });
    expect(after).toEqual({ ...before, errorCode: 'ITEM_LOGIN_REQUIRED' });
  });
});

describe('removeItem', () => {
  it('posts the access token to /item/remove', async () => {
    const { impl, calls } = fakeFetch([{ body: { request_id: 'r' } }]);
    await createPlaidProvider({ ...CONFIG, fetch: impl }).removeItem(new AccessToken('access-sandbox-1'));
    expect(calls[0].url).toBe('https://sandbox.plaid.com/item/remove');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ access_token: 'access-sandbox-1' });
  });

  it('surfaces an already-removed Item as a PlaidApiError for the caller to judge', async () => {
    const { impl } = fakeFetch([
      {
        status: 400,
        body: { error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND', error_message: 'the Item you requested cannot be found.', request_id: 'r' },
      },
    ]);
    await expect(createPlaidProvider({ ...CONFIG, fetch: impl }).removeItem(new AccessToken('a'))).rejects.toMatchObject({
      errorCode: 'ITEM_NOT_FOUND',
    });
  });
});

describe('exchangePublicToken', () => {
  it('returns the item id and access token', async () => {
    const { impl, calls } = fakeFetch([{ body: { access_token: 'access-sandbox-1', item_id: 'item-1', request_id: 'r' } }]);
    const item = await createPlaidProvider({ ...CONFIG, fetch: impl }).exchangePublicToken('public-sandbox-1');
    expect(item.itemId).toBe('item-1');
    expect(item.accessToken).toBeInstanceOf(AccessToken);
    expect(item.accessToken.reveal()).toBe('access-sandbox-1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ public_token: 'public-sandbox-1' });
  });
});

describe('getAccounts', () => {
  it('maps accounts and institution onto provider-neutral fields', async () => {
    const { impl } = fakeFetch([{ body: ACCOUNTS_BODY }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).getAccounts(new AccessToken('access-sandbox-1'));
    expect(result).toEqual({
      itemId: 'item-1',
      institutionId: 'ins_109508',
      institutionName: 'First Platypus Bank',
      accounts: [
        {
          providerAccountId: 'acc-checking',
          persistentAccountId: null,
          name: 'Plaid Checking',
          officialName: 'Plaid Gold Standard 0% Interest Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
        },
        {
          providerAccountId: 'acc-card',
          persistentAccountId: null,
          name: 'Plaid Credit Card',
          officialName: null,
          mask: '3333',
          type: 'credit',
          subtype: 'credit card',
        },
      ],
    });
  });

  it('tolerates an Item with no institution', async () => {
    const body = { ...ACCOUNTS_BODY, item: { item_id: 'item-1' } };
    const { impl } = fakeFetch([{ body }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).getAccounts(new AccessToken('a'));
    expect(result.institutionId).toBeNull();
    expect(result.institutionName).toBeNull();
  });

  it('rejects a response missing a required field', async () => {
    const body = { ...ACCOUNTS_BODY, accounts: [{ ...ACCOUNTS_BODY.accounts[0], account_id: undefined }] };
    const { impl } = fakeFetch([{ body }]);
    await expect(createPlaidProvider({ ...CONFIG, fetch: impl }).getAccounts(new AccessToken('a'))).rejects.toThrow(
      /did not match the expected shape at accounts\.0\.account_id/,
    );
  });
});

describe('errors', () => {
  it('surfaces Plaid error envelopes as PlaidApiError', async () => {
    const { impl } = fakeFetch([
      {
        status: 400,
        body: {
          error_type: 'INVALID_INPUT',
          error_code: 'INVALID_PUBLIC_TOKEN',
          error_message: 'provided public token is expired',
          display_message: null,
          request_id: 'req-9',
        },
      },
    ]);
    const err = await createPlaidProvider({ ...CONFIG, fetch: impl })
      .exchangePublicToken('public-sandbox-old')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidApiError);
    expect(err).toMatchObject({
      status: 400,
      errorType: 'INVALID_INPUT',
      errorCode: 'INVALID_PUBLIC_TOKEN',
      requestId: 'req-9',
    });
  });

  it('reports a non-JSON failure without its body', async () => {
    const { impl } = fakeFetch([{ status: 502, body: '<html>bad gateway</html>' }]);
    await expect(
      createPlaidProvider({ ...CONFIG, fetch: impl }).exchangePublicToken('p'),
    ).rejects.toThrow('Plaid /item/public_token/exchange returned non-JSON (HTTP 502)');
  });
});
