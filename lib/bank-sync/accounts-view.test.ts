import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  institutionLine,
  itemsLeft,
  itemsUsed,
  loginsByInstitution,
  notSyncingReason,
  twinAccounts,
  twinSentence,
  twinSummary,
  type ViewLogin,
} from './accounts-view';

const login = (id: string, over: Partial<ViewLogin> = {}): ViewLogin => ({
  id,
  institutionId: 'ins_109508',
  institutionName: 'First Platypus Bank',
  createdAt: new Date('2026-10-20T00:00:00Z'),
  status: 'active',
  accounts: [
    { id: `${id}-checking`, name: 'Plaid Checking', mask: '0000', syncable: true, syncEnabled: false },
    { id: `${id}-card`, name: 'Plaid Credit Card', mask: '3333', syncable: true, syncEnabled: true },
    { id: `${id}-401k`, name: 'Plaid 401k', mask: '6666', syncable: false, syncEnabled: false },
  ],
  ...over,
});

describe('the Item budget', () => {
  it('counts every login ever linked, removed ones too, against 10', () => {
    const logins = [login('a'), login('b', { status: 'paused' }), login('c', { status: 'removed' })];
    expect(itemsUsed(logins)).toBe(3);
    expect(itemsLeft(logins)).toBe(7);
    expect(itemsLeft(Array.from({ length: 11 }, (_, i) => login(`x${i}`)))).toBe(0);
  });
});

describe('twinAccounts', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);

  it('finds the same account under two logins at one institution, among accounts that can sync', () => {
    const twins = twinAccounts([login('a'), login('b', { createdAt: new Date('2026-10-22T00:00:00Z') })]);
    expect([...twins.keys()].sort()).toEqual(['a-card', 'a-checking', 'b-card', 'b-checking']);
    expect(twins.get('a-card')!.map((t) => [t.login.id, t.syncingThere])).toEqual([['b', true]]);
  });

  it('says it is counted twice only when both copies sync', () => {
    const twins = twinAccounts([login('a'), login('b', { createdAt: new Date('2026-10-22T00:00:00Z') })]);
    expect(twinSentence(twins.get('a-card')!, true, day)).toBe(
      'Also linked and syncing under the First Platypus Bank login from 2026-10-22: every transaction on it is counted twice. Keep sync on for one copy only.',
    );
    expect(twinSentence(twins.get('a-checking')!, false, day)).toBe(
      'Also linked under the First Platypus Bank login from 2026-10-22. If more than one copy syncs, its transactions are counted more than once; keep sync on for one only.',
    );
    const paused = twinAccounts([login('a'), login('b', { status: 'paused' })]);
    expect(paused.get('a-card')![0].syncingThere).toBe(false);
  });

  it('ignores removed logins, other institutions, and accounts that differ in name or mask', () => {
    expect(twinAccounts([login('a'), login('b', { status: 'removed' })]).size).toBe(0);
    expect(twinAccounts([login('a'), login('b', { institutionId: 'ins_3' })]).size).toBe(0);
    expect(
      twinAccounts([
        login('a'),
        login('b', { accounts: [{ id: 'b-card', name: 'Plaid Credit Card', mask: '9999', syncable: true, syncEnabled: true }] }),
      ]).size,
    ).toBe(0);
  });
});

describe('twinSummary', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const a = login('a');
  const b = login('b', { createdAt: new Date('2026-10-22T00:00:00Z') });
  const of = (l: ViewLogin, logins: ViewLogin[]) => {
    const twins = twinAccounts(logins);
    return l.accounts.map((acc) => ({ twins: twins.get(acc.id) ?? [], syncingHere: acc.syncEnabled }));
  };

  it('asks the owner to act, once per login, when an account syncs under both logins', () => {
    expect(twinSummary(of(a, [a, b]), day)).toEqual({
      needsOwner: true,
      text:
        '1 account here also syncs under the First Platypus Bank login from 2026-10-22, so its transactions are counted twice. ' +
        'Keep sync on for one copy of it only.',
    });
  });

  it('is information only when no account syncs under both', () => {
    const off = login('c', {
      createdAt: new Date('2026-10-22T00:00:00Z'),
      accounts: a.accounts.map((acc) => ({ ...acc, id: `c-${acc.id}`, syncEnabled: false })),
    });
    expect(twinSummary(of(a, [a, off]), day)).toEqual({
      needsOwner: false,
      text: '2 accounts here are also linked under the First Platypus Bank login from 2026-10-22.',
    });
  });

  it('says nothing for a login with no twins', () => {
    expect(twinSummary(of(login('c', { institutionId: 'ins_3' }), [a]), day)).toBeNull();
  });
});

describe('logins grouped by institution', () => {
  const day = (d: Date) => d.toISOString().slice(5, 10);
  const at = (name: string, iso: string) => ({ institutionName: name, createdAt: new Date(iso) });

  it('gives one line per institution, its logins counted and dated in order', () => {
    const groups = loginsByInstitution(
      [
        at('First Platypus Bank', '2026-10-25T00:00:00Z'),
        at('Chase', '2026-11-01T00:00:00Z'),
        at('First Platypus Bank', '2026-10-20T00:00:00Z'),
        at('First Platypus Bank', '2026-10-25T00:00:00Z'),
      ],
      day,
    );
    expect(groups.map(institutionLine)).toEqual(['Chase — 1 login (11-01)', 'First Platypus Bank — 3 logins (10-20, 10-25, 10-25)']);
  });

  it('names several other logins at one bank once, in a duplicate-account sentence', () => {
    const a = login('a');
    const b = login('b', { createdAt: new Date('2026-10-22T00:00:00Z') });
    const c = login('c', { createdAt: new Date('2026-10-25T00:00:00Z') });
    const twins = twinAccounts([a, b, c]);
    expect(twinSentence(twins.get('a-card')!, true, day)).toBe(
      'Also linked and syncing under 2 other First Platypus Bank logins (10-22, 10-25): every transaction on it is counted 3 times. Keep sync on for one copy only.',
    );
  });
});

describe('notSyncingReason', () => {
  const active = { status: 'active' as const, itemErrorCode: null };
  it('names what stops an account, most decisive first, and only a broken login asks the owner to act', () => {
    expect(notSyncingReason({ ...active, status: 'removed' }, { unsharedAt: new Date() })).toEqual({ text: 'login removed; not syncing', needsOwner: false });
    expect(notSyncingReason({ ...active, status: 'paused' }, { unsharedAt: null })).toEqual({ text: 'paused; not syncing', needsOwner: false });
    expect(notSyncingReason(active, { unsharedAt: new Date() })).toEqual({ text: 'no longer shared by the bank; not syncing', needsOwner: false });
    expect(notSyncingReason({ ...active, itemErrorCode: 'ITEM_LOGIN_REQUIRED' }, { unsharedAt: null })).toEqual({
      text: 'not syncing: reconnect on Accounts',
      needsOwner: true,
    });
    expect(notSyncingReason({ ...active, itemErrorCode: 'ITEM_NOT_FOUND' }, { unsharedAt: null })).toEqual({
      text: 'Plaid no longer has this login; not syncing',
      needsOwner: true,
    });
  });

  it('says nothing for a healthy login or a bank that is only down for now', () => {
    expect(notSyncingReason(active, { unsharedAt: null })).toBeNull();
    expect(notSyncingReason({ ...active, itemErrorCode: 'INSTITUTION_DOWN' }, { unsharedAt: null })).toBeNull();
  });
});

describe('action sentences', () => {
  it('removal names the rows that stay, the pending rows that go, and the slot that is not returned', () => {
    expect(actionSentence.remove('Chase', 214, 7)).toBe(
      "Ends Plaid's access to Chase and erases the stored token, for good. Its 214 rows, with their splits and settlements, stay; " +
        'its pending rows, which never counted, are deleted. ' +
        'The Item\'s slot is not returned: linking Chase again would use a new one (7 of 10 left).',
    );
    expect(actionSentence.remove('First Platypus Bank', 1, null)).toMatch(/Its 1 row, with .* In Sandbox, Items are free\.$/);
  });

  it('pause keeps the rows counting and changes nothing at Plaid', () => {
    expect(actionSentence.pause('Amex', 0)).toBe(
      'Stops syncing Amex. Its 0 rows stay and keep counting, and nothing changes at Plaid. Resume continues from where it stopped.',
    );
  });

  it('no repair sentence suggests linking again', () => {
    for (const s of [actionSentence.reconnect('Chase'), actionSentence.chooseAccounts('Chase'), actionSentence.check()]) {
      expect(s).not.toMatch(/link(ing)? .*again/i);
    }
  });
});
