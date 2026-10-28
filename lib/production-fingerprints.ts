// sha256 fingerprints of production's Neon endpoint id and Blob store id, for
// the deployment guard (lib/deploy-guard.ts). Generate them with
// `npm run guard:fingerprint` while production's environment is loaded; the
// script prints hashes only. The ids are hashed so this file can be public.
//
// plaidSecrets holds the sha256 of production's Plaid secret: a 120-bit random
// value, so its hash reveals nothing and is safe to publish. Generate it
// without the secret touching a file or shell history: copy the secret from
// the Plaid dashboard, then `pbpaste | tr -d '\n' | shasum -a 256 && pbcopy
// </dev/null`. Replace the entry whenever the secret is rotated.
//
// The positive markers in db/demo-guard.ts already keep production out of a
// demo build whether or not these are filled in; this list is the second,
// offline layer.
export const PRODUCTION_FINGERPRINTS = {
  databaseEndpoints: ['7aa88e3195553579a4993423a98189c18f275dae947ccb6d012a0c29af51226d'],
  blobStores: ['c82091422c9587a95e199eda173e7704693c8209f030ea9216e32ac2790c7081'],
  plaidSecrets: ['c873fb43b933669f998038ccaacfa75096c29f39802ef97f2cf2138c675c79b5'],
};
