import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlaidProvider, MAX_SYNC_RESTARTS } from './provider';
import { parseJsonExact } from './client';
import { AccessToken } from '../access-token';
import { SyncBudgetExceededError } from '../provider';

// Recorded from Plaid Sandbox and trimmed (see the fixture's _comment). The
// file is read as text so its numbers reach the provider in wire form.
const FIXTURE_TEXT = readFileSync(
  join(__dirname, '../../../tests/fixtures/plaid/sandbox-sync.json'),
  'utf8',
);
const fixture = parseJsonExact(FIXTURE_TEXT) as {
  checking: { added: { account_id: string }[] };
  creditCard: { added: { account_id: string }[] };
};
// One page body per fixture account, re-cut from the text so amounts stay
// exactly as Plaid sent them.
function pageText(which: 'checking' | 'creditCard', overrides: Record<string, unknown> = {}): string {
  const whole = FIXTURE_TEXT;
  const start = whole.indexOf(`"${which}": {`) + `"${which}": `.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < whole.length; i++) {
    if (whole[i] === '{') depth++;
    if (whole[i] === '}') depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  let text = whole.slice(start, end);
  for (const [key, value] of Object.entries(overrides)) {
    text = text.replace(new RegExp(`"${key}": [^,\\n]+`), `"${key}": ${JSON.stringify(value)}`);
  }
  return text;
}

const CHECKING = fixture.checking.added[0].account_id;
const CARD = fixture.creditCard.added[0].account_id;
const TOKEN = new AccessToken('access-sandbox-1');
const CONFIG = { clientId: 'c', secret: 's', env: 'sandbox' as const };

function fakeFetch(bodies: { status?: number; text: string }[]) {
  const requests: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = bodies.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(next.text, { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, requests };
}

const MUTATION = JSON.stringify({
  error_type: 'TRANSACTIONS_ERROR',
  error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
  error_message: 'Underlying transaction data changed since last page was fetched.',
  display_message: null,
  request_id: 'r',
});

describe('syncTransactions against the recorded Sandbox page', () => {
  it('converts amounts exactly, with the canonical sign', async () => {
    const { impl } = fakeFetch([{ text: pageText('checking') }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    const byDescription = Object.fromEntries(result.added.map((t) => [t.descriptionRaw, t.amountCents]));
    // Purchases out of checking are positive; the refund in is negative.
    expect(byDescription).toMatchObject({
      Starbucks: 4_330,
      SparkFun: 89_400,
      'McDonalds #3322': 12_000,
      'United Airlines **** REFUND ****': -500_000,
      'Uber 072515 SF**POOL**': 6_330,
    });
    expect(result.nextCursor).toBe('fixture-cursor-1');
    expect(result.readiness).toBe('historical');
    expect(result.pages).toBe(1);
  });

  it("carries Plaid's own category (personal finance category, primary) on each row", async () => {
    const { impl } = fakeFetch([{ text: pageText('checking') }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    const starbucks = result.added.find((t) => t.descriptionRaw === 'Starbucks');
    expect(starbucks?.bankCategory).toBe('FOOD_AND_DRINK');
    expect(result.added.every((t) => typeof t.bankCategory === 'string')).toBe(true);
  });

  it('keeps the raw object with numbers as their source text', async () => {
    const { impl } = fakeFetch([{ text: pageText('checking') }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    expect((result.added[1].raw as { amount: unknown }).amount).toBe('89.4');
  });

  it('falls back to the posted date only when the bank gives no authorized date', async () => {
    const { impl } = fakeFetch([{ text: pageText('creditCard') }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CARD,
      cursor: null,
    });
    const kfc = result.added.find((t) => t.descriptionRaw === 'KFC')!;
    expect(kfc.authorizedDate).toBeNull();
    const climbing = result.added.find((t) => t.descriptionRaw === 'Touchstone Climbing')!;
    expect(climbing.authorizedDate).not.toBeNull();
  });

  it('asks for one account, the bank description, and the largest page', async () => {
    const { impl, requests } = fakeFetch([{ text: pageText('checking') }]);
    await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: 'stored-cursor',
    });
    expect(requests[0]).toEqual({
      access_token: 'access-sandbox-1',
      cursor: 'stored-cursor',
      count: 500,
      options: { include_original_description: true, account_id: CHECKING },
    });
  });

  it('omits the cursor on a first sync', async () => {
    const { impl, requests } = fakeFetch([{ text: pageText('checking') }]);
    await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    expect(requests[0]).not.toHaveProperty('cursor');
  });
});

describe('pagination', () => {
  it('follows has_more and collects every page', async () => {
    const { impl, requests } = fakeFetch([
      { text: pageText('checking', { has_more: true, next_cursor: 'page-2' }) },
      { text: pageText('checking', { next_cursor: 'final' }).replace(/"transaction_id": "/g, '"transaction_id": "p2-') },
    ]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    expect(result.pages).toBe(2);
    expect(result.added).toHaveLength(10);
    expect(result.nextCursor).toBe('final');
    expect(requests[1].cursor).toBe('page-2');
  });

  it('restarts from the starting cursor after a mid-pagination mutation, discarding partial pages', async () => {
    const { impl, requests } = fakeFetch([
      { text: pageText('checking', { has_more: true, next_cursor: 'page-2' }) },
      { status: 400, text: MUTATION },
      { text: pageText('checking', { next_cursor: 'after-restart' }) },
    ]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: 'start',
    });
    expect(requests.map((r) => r.cursor)).toEqual(['start', 'page-2', 'start']);
    expect(result.restarts).toBe(1);
    expect(result.added).toHaveLength(5);
    expect(result.nextCursor).toBe('after-restart');
  });

  it('gives up after too many restarts', async () => {
    const bodies = Array.from({ length: MAX_SYNC_RESTARTS + 1 }, () => ({ status: 400, text: MUTATION }));
    const { impl } = fakeFetch(bodies);
    await expect(
      createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
        providerAccountId: CHECKING,
        cursor: 'start',
      }),
    ).rejects.toThrow(/TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION/);
  });

  it('stops with a clear error once past its deadline instead of running into the timeout', async () => {
    const { impl } = fakeFetch([{ text: pageText('checking', { has_more: true, next_cursor: 'page-2' }) }]);
    const provider = createPlaidProvider({ ...CONFIG, fetch: impl });
    let calls = 0;
    const deadline = Date.now() + 60_000;
    const realNow = Date.now;
    // The first page is requested before the deadline; the clock then jumps.
    Date.now = () => (calls++ < 2 ? realNow() : deadline + 1);
    try {
      await expect(
        provider.syncTransactions(TOKEN, { providerAccountId: CHECKING, cursor: null, deadline }),
      ).rejects.toBeInstanceOf(SyncBudgetExceededError);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('readiness', () => {
  it('reports not ready, and no cursor, while Plaid is still loading history', async () => {
    const body = JSON.stringify({
      added: [],
      modified: [],
      removed: [],
      next_cursor: '',
      has_more: false,
      transactions_update_status: 'NOT_READY',
      accounts: [],
      request_id: 'r',
    });
    const { impl } = fakeFetch([{ text: body }]);
    const result = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    expect(result).toMatchObject({ added: [], nextCursor: null, readiness: 'not_ready' });
  });
});

describe('amounts that are not exact decimals', () => {
  it('stop the fetch rather than being rounded', async () => {
    const text = pageText('checking').replace(/"amount": 4\.33/, '"amount": 4.33e-1');
    const { impl } = fakeFetch([{ text }]);
    await expect(
      createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
        providerAccountId: CHECKING,
        cursor: null,
      }),
    ).rejects.toThrow(/not an exact decimal: 4.33e-1/);
  });
});

describe('parseJsonExact', () => {
  it('returns every number as its source text', () => {
    expect(parseJsonExact('{"a":0.1,"b":-4.33,"c":[25,1e3]}')).toEqual({
      a: '0.1',
      b: '-4.33',
      c: ['25', '1e3'],
    });
  });
});

describe('the synced path categorizes', () => {
  // The recorded page through the real provider, normalizer, and planner, with
  // a rule shaped like the owner's real one (regex, case-insensitive). Guards
  // against "rules never ran" looking like "nothing matched".
  it('applies a matching rule to a synced row and leaves the rest uncategorized', async () => {
    const { planSync } = await import('../plan');
    const { impl } = fakeFetch([{ text: pageText('checking') }]);
    const fetched = await createPlaidProvider({ ...CONFIG, fetch: impl }).syncTransactions(TOKEN, {
      providerAccountId: CHECKING,
      cursor: null,
    });
    const plan = planSync({
      providerAccountId: CHECKING,
      added: fetched.added,
      modified: fetched.modified,
      removed: fetched.removed,
      stored: new Map(),
      storedElsewhere: new Set(),
      nonSplittableCategoryIds: new Set(),
      rules: [
        { categoryId: 'cat-transport', matchPattern: 'UBER|LYFT', matchType: 'regex', priority: 100, createdAt: '2026-07-20' },
      ],
    });
    if (plan.kind !== 'apply') throw new Error(plan.reason);
    const byMerchant = Object.fromEntries(plan.inserts.map((i) => [i.merchantNormalized, [i.categoryId, i.categorySource]]));
    expect(byMerchant['UBER 072515 SF**POOL**']).toEqual(['cat-transport', 'rule']);
    expect(byMerchant['STARBUCKS']).toEqual([null, null]);
  });
});
