import { describe, expect, it } from 'vitest';
import {
  classifyItemError,
  consentState,
  healthClause,
  healthLabel,
  healthSentence,
  isGone,
  offersReconnect,
  type ItemHealthKind,
} from './item-health';

describe('classifyItemError', () => {
  it.each<[string | null, ItemHealthKind]>([
    [null, 'healthy'],
    ['ITEM_LOGIN_REQUIRED', 'reconnect'],
    ['PENDING_EXPIRATION', 'reconnect'],
    ['PENDING_DISCONNECT', 'reconnect'],
    ['INVALID_CREDENTIALS', 'reconnect'],
    ['INSUFFICIENT_CREDENTIALS', 'reconnect'],
    ['INVALID_UPDATED_USERNAME', 'reconnect'],
    ['ITEM_LOCKED', 'fix_at_bank'],
    ['USER_SETUP_REQUIRED', 'fix_at_bank'],
    ['PASSWORD_RESET_REQUIRED', 'fix_at_bank'],
    ['INSTITUTION_DOWN', 'bank_unavailable'],
    ['INSTITUTION_NOT_RESPONDING', 'bank_unavailable'],
    ['INSTITUTION_NOT_AVAILABLE', 'bank_unavailable'],
    ['ITEM_NOT_FOUND', 'gone'],
    ['INVALID_ACCESS_TOKEN', 'gone'],
    ['USER_PERMISSION_REVOKED', 'unknown'],
    ['SOMETHING_NEW', 'unknown'],
  ])('%s is %s', (code, kind) => {
    expect(classifyItemError(code)).toBe(kind);
  });
});

describe('the repair offered', () => {
  it('offers Reconnect for every state but a login Plaid no longer has', () => {
    const kinds: ItemHealthKind[] = ['healthy', 'reconnect', 'fix_at_bank', 'bank_unavailable', 'gone', 'unknown'];
    expect(kinds.filter(offersReconnect)).toEqual(['healthy', 'reconnect', 'fix_at_bank', 'bank_unavailable', 'unknown']);
  });

  it('never tells the owner to link again, for any code', () => {
    // Plaid's own guidance for some of these is to link the account again,
    // which spends an Item. Only `gone` mentions a new Item, and only to
    // say what it would cost.
    for (const code of [
      'ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_UPDATED_USERNAME', 'ITEM_LOCKED',
      'USER_SETUP_REQUIRED', 'PASSWORD_RESET_REQUIRED', 'INSTITUTION_DOWN', 'ACCESS_NOT_GRANTED', 'SOMETHING_NEW',
    ]) {
      const sentence = healthSentence(code, 'Chase')!;
      expect(sentence).not.toMatch(/link (it |the account |Chase )?again/i);
      expect(sentence).not.toMatch(/would use a new Item/);
    }
    expect(healthSentence('ITEM_NOT_FOUND', 'Chase')).toBe(
      'Plaid no longer recognises this login (ITEM_NOT_FOUND), so Reconnect cannot repair it. Its rows stay. ' +
        'To sync Chase again, remove this login (that uses nothing at Plaid), then link Chase, which uses a new Item.',
    );
  });

  it('says nothing for a healthy login', () => {
    expect(healthSentence(null, 'Chase')).toBeNull();
  });

  it('treats only the gone codes as already removed', () => {
    expect(isGone('ITEM_NOT_FOUND')).toBe(true);
    expect(isGone('INVALID_ACCESS_TOKEN')).toBe(true);
    expect(isGone('ITEM_LOGIN_REQUIRED')).toBe(false);
    expect(isGone(null)).toBe(false);
  });
});

describe('consentState', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  it('distinguishes no expiry, far, within a week, and past', () => {
    expect(consentState(null, now)).toBe('none');
    expect(consentState(new Date('2026-11-10T12:00:00Z'), now)).toBe('ok');
    expect(consentState(new Date('2026-11-03T12:00:00Z'), now)).toBe('soon');
    expect(consentState(new Date('2026-10-27T12:00:00Z'), now)).toBe('expired');
  });
});

describe('healthLabel and healthClause', () => {
  it('say nothing for a healthy login and name an unknown code as is', () => {
    expect(healthLabel(null)).toBeNull();
    expect(healthClause(null)).toBeNull();
    expect(healthLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(healthClause('SOMETHING_NEW')).toBe('Plaid reports SOMETHING_NEW');
  });

  it('give a short reason, never the repair, for every kind', () => {
    expect(healthLabel('ITEM_LOGIN_REQUIRED')).toBe('Needs reconnecting');
    expect(healthClause('ITEM_LOGIN_REQUIRED')).toBe('the login needs reconnecting');
    for (const code of ['ITEM_LOGIN_REQUIRED', 'ITEM_LOCKED', 'INSTITUTION_DOWN', 'ITEM_NOT_FOUND', 'SOMETHING_NEW']) {
      expect(healthClause(code)).not.toMatch(/Reconnect opens|new Item|link/i);
    }
  });
});

