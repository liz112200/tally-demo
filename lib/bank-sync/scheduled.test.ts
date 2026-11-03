import { describe, expect, it } from 'vitest';
import { syncInTurn, type OneLoginResult } from './scheduled';

const logins = [
  { connectionId: 'a', label: 'Bank A' },
  { connectionId: 'b', label: 'Bank B' },
  { connectionId: 'c', label: 'Bank C' },
];

describe('syncInTurn', () => {
  it('runs every login in order, and one that throws or fails does not stop the next', async () => {
    const ran: string[] = [];
    const results: Record<string, () => Promise<OneLoginResult>> = {
      a: async () => {
        throw new Error('Plaid timed out');
      },
      b: async () => ({ error: 'The bank refused the request.' }),
      c: async () => ({ lines: ['Card ••0001: 2 new.'], complete: true }),
    };
    const out = await syncInTurn(logins, (id) => (ran.push(id), results[id]()), Number.MAX_SAFE_INTEGER);
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(out.map((o) => [o.connectionId, o.result, o.lines])).toEqual([
      ['a', 'failed', ['Plaid timed out']],
      ['b', 'failed', ['The bank refused the request.']],
      ['c', 'synced', ['Card ••0001: 2 new.']],
    ]);
  });

  it('reports a paused login as skipped and an unfinished one as incomplete', async () => {
    const out = await syncInTurn(
      logins.slice(0, 2),
      async (id) => (id === 'a' ? { notRun: 'paused' } : { lines: ['still preparing'], complete: false }),
      Number.MAX_SAFE_INTEGER,
    );
    expect(out.map((o) => o.result)).toEqual(['skipped', 'incomplete']);
  });

  it('starts no login after the deadline, and says which were left', async () => {
    let clock = 0;
    const ran: string[] = [];
    const out = await syncInTurn(
      logins,
      async (id) => {
        ran.push(id);
        clock += 100;
        return { lines: [], complete: true };
      },
      150,
      () => clock,
    );
    expect(ran).toEqual(['a', 'b']);
    expect(out.map((o) => o.result)).toEqual(['synced', 'synced', 'not_reached']);
  });
});
