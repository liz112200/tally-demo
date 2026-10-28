// Serves recorded Plaid responses to the real client (lib/bank-sync/plaid),
// through the `fetch` its config accepts, so a test runs the actual HTTP
// layer, exact-number parsing, validation and pagination on Plaid's own
// bytes. Each request must carry the cursor the recording was made with, so
// the cursors the app stores are checked too. Rounds can be appended, built
// from recorded transaction objects, for what Sandbox cannot produce
// (modified and removed posted rows): only Plaid's decision to send them is
// made up.
//
// /item/get, which every sync calls first, is answered from a separate
// recording (sandbox-item-health.json): Plaid's response for the healthy
// Item, or, with `itemHealth: 'login_required'`, its response after
// /sandbox/item/reset_login. Only the item_id is rewritten, to the test's
// own connection.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type RecordedPage = { request: { cursor?: string; count: number; options: { account_id: string } }; response: string };
export type Recording = {
  account: { account_id: string; name: string; type: string; subtype: string };
  rounds: RecordedPage[][];
};

export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/plaid', name), 'utf8'));
}

type HealthRecording = { calls: { path: string; status: number; response: string }[] };

function recordedItemGet(health: 'healthy' | 'login_required', itemId: string): string {
  const recorded: HealthRecording = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/plaid/sandbox-item-health.json'), 'utf8'),
  );
  const [before, , after] = recorded.calls;
  const body = JSON.parse((health === 'healthy' ? before : after).response);
  body.item.item_id = itemId;
  return JSON.stringify(body);
}

export function replay(
  recording: Recording,
  options: { itemId: string; itemHealth?: 'healthy' | 'login_required' },
) {
  const queue: RecordedPage[] = recording.rounds.flat();
  const last = queue.at(-1) as RecordedPage;
  // Where the next appended page continues from.
  let tailCursor: string = JSON.parse(last.response).next_cursor;
  let appended = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    if (path === '/item/get' && body.access_token) {
      return new Response(recordedItemGet(options.itemHealth ?? 'healthy', options.itemId), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path !== '/transactions/sync') throw new Error(`replay: unexpected request to ${path}`);
    const next = queue.shift();
    if (!next) throw new Error('replay: no recorded response left');
    if ((body.cursor ?? null) !== (next.request.cursor ?? null)) {
      throw new Error(`replay: cursor ${body.cursor ?? 'null'} sent, recording expects ${next.request.cursor ?? 'null'}`);
    }
    if (body.options?.account_id !== next.request.options.account_id || !body.access_token) {
      throw new Error('replay: request does not match the recording');
    }
    return new Response(next.response, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return {
    impl,
    remaining: () => queue.length,
    // Append one page after everything recorded, continuing its cursor chain.
    append(page: { added?: unknown[]; modified?: unknown[]; removed?: { transaction_id: string; account_id: string }[] }) {
      appended += 1;
      const nextCursor = `${tailCursor}-appended-${appended}`;
      queue.push({
        request: { cursor: tailCursor, count: 500, options: last.request.options },
        response: JSON.stringify({
          accounts: [],
          added: page.added ?? [],
          modified: page.modified ?? [],
          removed: page.removed ?? [],
          next_cursor: nextCursor,
          has_more: false,
          request_id: 'replay',
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        }),
      });
      tailCursor = nextCursor;
    },
  };
}

// Every transaction object the recording delivered in `added`, by id.
export function recordedTransactions(recording: Recording): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const page of recording.rounds.flat()) {
    for (const t of JSON.parse(page.response).added) out.set(t.transaction_id, t);
  }
  return out;
}
