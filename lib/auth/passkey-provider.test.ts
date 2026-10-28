import { describe, expect, it } from 'vitest';
import { passkeyWhere } from './passkey-provider';

describe('passkeyWhere', () => {
  it('names the provider, and what it reaches, only when the AAGUID says so', () => {
    expect(passkeyWhere({ aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd', deviceType: 'multiDevice' })).toBe(
      'in iCloud Keychain, usable on Apple devices signed in to the same Apple Account',
    );
    expect(passkeyWhere({ aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', deviceType: 'multiDevice' })).toBe(
      'in Google Password Manager, usable in Chrome and on Android devices signed in to the same Google account',
    );
  });

  it('claims nothing about sync for an unknown or unreported provider', () => {
    for (const aaguid of ['00000000-0000-0000-0000-000000000000', 'not-in-the-list']) {
      expect(passkeyWhere({ aaguid, deviceType: 'multiDevice' })).toBe(
        'its provider did not say which; it may not be on your other devices',
      );
    }
    expect(passkeyWhere({ aaguid: null, deviceType: 'multiDevice' })).toBe('provider not recorded');
    expect(passkeyWhere({ aaguid: null, deviceType: 'singleDevice' })).toBe('kept on the device that made it, and only there');
  });

  it('never says "synced"', () => {
    for (const deviceType of ['singleDevice', 'multiDevice'])
      for (const aaguid of [null, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd', 'x'])
        expect(passkeyWhere({ aaguid, deviceType })).not.toMatch(/synced/i);
  });
});
