// Print the deployment-guard fingerprints of whatever credentials are in the
// environment, for lib/production-fingerprints.ts. Hashes only; the
// credentials themselves are never printed.
//
//   npm run guard:fingerprint                 # reads .env.local
//   npm run guard:fingerprint -- .env.prod    # or a pulled env file
import { config } from 'dotenv';
import { blobStoreId, databaseEndpointId, fingerprint } from '../lib/deploy-guard';

config({ path: process.argv[2] ?? '.env.local', quiet: true });

const endpoint = databaseEndpointId(process.env.DATABASE_URL);
const store = blobStoreId(process.env.BLOB_READ_WRITE_TOKEN);
console.log(`databaseEndpoints: ${endpoint ? JSON.stringify(fingerprint(endpoint)) : '(DATABASE_URL not set)'}`);
console.log(`blobStores:        ${store ? JSON.stringify(fingerprint(store)) : '(BLOB_READ_WRITE_TOKEN not set)'}`);
