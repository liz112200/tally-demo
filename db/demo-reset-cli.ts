// npm run demo:reset — rebuild the demo's data by hand. Reads .env.demo only
// (never .env.local, which holds the owner's real credentials); the reset
// itself refuses any store without the demo markers.
import { config } from 'dotenv';
import { resetDemo } from './demo-reset';

config({ path: '.env.demo', quiet: true });

resetDemo({
  DATABASE_URL: process.env.DATABASE_URL,
  BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
})
  .then(({ transactions, receipts }) => {
    console.log(`Demo reset: ${transactions} transactions, ${receipts} receipts.`);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
