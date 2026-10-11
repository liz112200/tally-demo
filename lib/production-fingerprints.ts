// sha256 fingerprints of production's Neon endpoint id and Blob store id, for
// the demo deployment guard (lib/deploy-guard.ts). Generate them with
// `npm run guard:fingerprint` while production's environment is loaded; the
// script prints hashes only. The ids are hashed so this file can be public.
//
// The positive markers in db/demo-guard.ts already keep production out of a
// demo build whether or not these are filled in; this list is the second,
// offline layer.
export const PRODUCTION_FINGERPRINTS = {
  databaseEndpoints: ['7aa88e3195553579a4993423a98189c18f275dae947ccb6d012a0c29af51226d'],
  blobStores: ['c82091422c9587a95e199eda173e7704693c8209f030ea9216e32ac2790c7081'],
};
