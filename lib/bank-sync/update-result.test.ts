import { describe, expect, it } from 'vitest';
import { updateResultMessage, type UpdateOutcome } from './update-result';

const reconnected: UpdateOutcome = {
  accountSelection: false,
  health: null,
  reload: { ok: true, added: 0, unshared: 0, reshared: 0, reissued: 0 },
  sync: { ran: true, lines: ['Plaid Credit Card ••3333: 1 new.', 'Plaid Checking ••0000: no changes.'], complete: true },
};

describe('updateResultMessage', () => {
  it('says a Reconnect worked and what the sync it finished brought in', () => {
    expect(updateResultMessage(reconnected)).toEqual({
      kind: 'success',
      text: 'Reconnected and synced.',
      details: ['Plaid Credit Card ••3333: 1 new.', 'Plaid Checking ••0000: no changes.'],
    });
  });

  it('names account changes from Choose shared accounts, and says when there were none', () => {
    expect(
      updateResultMessage({ ...reconnected, accountSelection: true, reload: { ok: true, added: 1, unshared: 1, reshared: 0, reissued: 0 } }).text,
    ).toBe('Shared accounts updated and synced. Accounts: 1 added, with sync off; 1 no longer shared, now not syncing; their rows stay.');
    expect(updateResultMessage({ ...reconnected, accountSelection: true }).text).toBe(
      'Shared accounts updated and synced. Which accounts are shared did not change.',
    );
  });

  it('does not sync a login that is still unhealthy, or whose health could not be read, and says so', () => {
    expect(updateResultMessage({ ...reconnected, health: 'ITEM_LOGIN_REQUIRED', sync: { ran: false, reason: 'unhealthy' } })).toEqual({
      kind: 'warning',
      text: 'Reconnected, but Plaid still reports ITEM_LOGIN_REQUIRED, so nothing was synced.',
    });
    expect(updateResultMessage({ ...reconnected, health: undefined, sync: { ran: false, reason: 'unhealthy' } }).text).toBe(
      'Reconnected, but its status could not be read, so nothing was synced. Use Check shortly.',
    );
  });

  it('reports a sync that failed or did not finish in the same message, as a warning', () => {
    expect(updateResultMessage({ ...reconnected, sync: { ran: true, error: 'BANK_TOKEN_KEY is not set' } })).toEqual({
      kind: 'warning',
      text: 'Reconnected, but the sync failed: BANK_TOKEN_KEY is not set',
    });
    expect(
      updateResultMessage({
        ...reconnected,
        sync: { ran: true, lines: ['Plaid Checking ••0000: failed. The bank provider returned PRODUCT_NOT_READY.'], complete: false },
      }),
    ).toEqual({
      kind: 'warning',
      text: 'Reconnected, but the sync did not finish.',
      details: ['Plaid Checking ••0000: failed. The bank provider returned PRODUCT_NOT_READY.'],
    });
  });

  it('a paused login reconnects without syncing, and says how to sync', () => {
    expect(updateResultMessage({ ...reconnected, sync: { ran: false, reason: 'paused' } })).toEqual({
      kind: 'success',
      text: 'Reconnected. Not synced: this login is paused; Resume to sync.',
    });
  });

  it('names an account that looks re-issued, and a failed reload still syncs the accounts already recorded', () => {
    const reissued = updateResultMessage({ ...reconnected, reload: { ok: true, added: 1, unshared: 1, reshared: 0, reissued: 1 } });
    expect(reissued.text).toBe(
      'Reconnected and synced. Accounts: 1 added, with sync off; 1 looks like an account already here under a new id: ' +
        'adopt or decline on Accounts before it syncs; 1 no longer shared, now not syncing; their rows stay.',
    );
    const failed = updateResultMessage({ ...reconnected, reload: { ok: false, message: 'Timed out.' } });
    expect(failed.kind).toBe('warning');
    expect(failed.text).toMatch(/Its accounts could not be reloaded: Timed out\. Reconnect again to retry; it uses no new Item\./);
    expect(failed.details).toEqual(['Plaid Credit Card ••3333: 1 new.', 'Plaid Checking ••0000: no changes.']);
  });
});
