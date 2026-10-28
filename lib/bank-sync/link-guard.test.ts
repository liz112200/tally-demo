import { describe, expect, it } from 'vitest';
import { duplicateOverrideAllowed, duplicateRefusal, findLinkedLogin, type LinkedLogin } from './link-guard';

const login = (over: Partial<LinkedLogin>): LinkedLogin => ({
  institutionId: 'ins_3',
  institutionName: 'Chase',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  status: 'active',
  itemErrorCode: null,
  ...over,
});

describe('findLinkedLogin', () => {
  it('finds an active or paused login at the same institution', () => {
    expect(findLinkedLogin('ins_3', [login({})])).toMatchObject({ institutionName: 'Chase' });
    expect(findLinkedLogin('ins_3', [login({ status: 'paused' })])).toMatchObject({ status: 'paused' });
  });

  it('ignores removed logins, other institutions, and an institution Link did not report', () => {
    expect(findLinkedLogin('ins_3', [login({ status: 'removed' })])).toBeNull();
    expect(findLinkedLogin('ins_128026', [login({})])).toBeNull();
    expect(findLinkedLogin(null, [login({ institutionId: null })])).toBeNull();
  });
});

describe('the Sandbox override', () => {
  it('exists only in Sandbox', () => {
    expect(duplicateOverrideAllowed('sandbox')).toBe(true);
    expect(duplicateOverrideAllowed('production')).toBe(false);
    expect(duplicateOverrideAllowed(undefined)).toBe(false);
    expect(duplicateOverrideAllowed('Sandbox')).toBe(false);
  });
});

describe('duplicateRefusal', () => {
  it('says what was not done, claims nothing about the budget, and points at Reconnect', () => {
    expect(duplicateRefusal(login({}), 'Nov 1, 2026')).toBe(
      'Chase is already linked (since Nov 1, 2026). Nothing was linked: the new login was not exchanged, as Plaid advises for a duplicate. ' +
        'To fix that login, use Reconnect on it; linking it again would spend an Item on the same login.',
    );
  });

  it('for a login Plaid no longer recognises, points at removal, since Reconnect is not offered there', () => {
    expect(duplicateRefusal(login({ itemErrorCode: 'ITEM_NOT_FOUND' }), 'Nov 1, 2026')).toBe(
      'Chase is already linked (since Nov 1, 2026), but Plaid no longer recognises that login, so Reconnect cannot repair it. ' +
        'Nothing was linked. Remove that login first (that uses nothing at Plaid); linking Chase then uses a new Item.',
    );
  });
});
