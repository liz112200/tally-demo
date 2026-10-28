// Where a passkey lives, from the AAGUID its provider reports at
// registration (AUTH.md). Pure. The backup flag only says a passkey can be
// synced by whatever made it, not where it can be used: Chrome on a Mac
// keeps passkeys in Google Password Manager and Safari in iCloud Keychain,
// and neither can use the other's. So the Devices page names the provider
// when it is known, and makes no claim when it is not.
//
// AAGUIDs from the community-maintained list
// (github.com/passkeydeveloper/passkey-authenticator-aaguids), limited to
// providers whose ids are stable. A provider may report all zeros instead.
const PROVIDERS: Record<string, { name: string; reach?: string }> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': {
    name: 'iCloud Keychain',
    reach: 'usable on Apple devices signed in to the same Apple Account',
  },
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': { name: 'iCloud Keychain (managed)' },
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': {
    name: 'Google Password Manager',
    reach: 'usable in Chrome and on Android devices signed in to the same Google account',
  },
  'adce0002-35bc-c60a-648b-0b25f1f05503': { name: 'this Chrome profile on this Mac' },
  '08987058-cadc-4b81-b6e1-30de50dcbe96': { name: 'Windows Hello' },
  'bada5566-a7aa-401f-bd96-45619a55120d': { name: '1Password' },
  'd548826e-79b4-db40-a3d8-11116f7e8349': { name: 'Bitwarden' },
};

export function passkeyWhere(p: { aaguid: string | null; deviceType: string }): string {
  if (p.deviceType === 'singleDevice') return 'kept on the device that made it, and only there';
  if (p.aaguid === null) return 'provider not recorded';
  const known = PROVIDERS[p.aaguid];
  if (!known) return 'its provider did not say which; it may not be on your other devices';
  return known.reach ? `in ${known.name}, ${known.reach}` : `in ${known.name}`;
}
