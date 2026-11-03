import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, staleLines, type StaleAccount } from './staleness';

const now = new Date('2026-11-05T12:00:00Z');
const quiet = new Date(now.getTime() - STALE_AFTER_MS);
const account = (over: Partial<StaleAccount> = {}): StaleAccount => ({
  label: 'Card ••0001',
  institution: 'Example Bank',
  connectionStatus: 'active',
  itemErrorCode: null,
  consentExpiresAt: null,
  syncEnabled: true,
  unshared: false,
  lastSyncedAt: quiet,
  lastSyncError: null,
  ...over,
});

describe('staleLines', () => {
  it('says nothing before 36 hours, and speaks at exactly 36', () => {
    expect(staleLines([account({ lastSyncedAt: new Date(quiet.getTime() + 1) })], now)).toEqual([]);
    expect(staleLines([account()], now)).toHaveLength(1);
  });

  it('a login that needs the owner says what to do, and that it will not fix itself', () => {
    const [line] = staleLines([account({ itemErrorCode: 'ITEM_LOGIN_REQUIRED' })], now);
    expect(line.kind).toBe('needs_you');
    expect(line.text).toContain('Card ••0001 has not synced since Nov 4');
    expect(line.text).toContain('needs you to sign in again. Reconnect');
    expect(line.text).toContain('This will not fix itself.');
    expect(staleLines([account({ itemErrorCode: 'ITEM_LOCKED' })], now)[0].kind).toBe('needs_you');
    expect(staleLines([account({ consentExpiresAt: new Date('2026-11-04T00:00:00Z') })], now)[0].kind).toBe('needs_you');
  });

  it('a bank that was down, or a failed sync on a healthy login, is transient', () => {
    const [down] = staleLines([account({ itemErrorCode: 'INSTITUTION_DOWN' })], now);
    expect(down.kind).toBe('transient');
    expect(down.text).toContain('Example Bank was not answering');
    expect(down.text).toContain('look again if this is still here tomorrow');
    const [failed] = staleLines([account({ lastSyncError: 'Plaid timed out' })], now);
    expect(failed).toMatchObject({ kind: 'transient' });
    expect(failed.text).toContain('its last sync failed (Plaid timed out)');
  });

  it('a healthy login with no error means the daily sync itself did not run', () => {
    const [line] = staleLines([account()], now);
    expect(line.kind).toBe('not_run');
    expect(line.text).toContain('the daily sync has not run');
  });

  it('leaves out accounts that do not sync, and lists what needs the owner first', () => {
    expect(
      staleLines(
        [
          account({ syncEnabled: false }),
          account({ connectionStatus: 'paused' }),
          account({ connectionStatus: 'removed' }),
          account({ unshared: true }),
          account({ lastSyncedAt: null }),
        ],
        now,
      ),
    ).toEqual([]);
    const lines = staleLines([account({ label: 'A' }), account({ label: 'B', itemErrorCode: 'INSTITUTION_DOWN' }), account({ label: 'C', itemErrorCode: 'ITEM_LOGIN_REQUIRED' })], now);
    expect(lines.map((l) => l.kind)).toEqual(['needs_you', 'transient', 'not_run']);
  });
});
