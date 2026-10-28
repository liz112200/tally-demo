import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { isProductionDatabaseUrl } from '../lib/deploy-guard';

// PASSKEY RECOVERY (AUTH.md): forget every passkey and sign out every
// session, so the setup token can register a passkey again.
//
// Setup refuses while any passkey row exists, and a lost passkey's row does
// not go away by itself, so rotating AUTH_BOOTSTRAP_TOKEN alone recovers
// nothing. Run this first, then set a new token in Vercel and open /sign-in:
// the new passkey attaches to the same user (db/auth.ts bootstrapOwner), so
// the user, and their link to the ledger's owner person, stay as they were.
// Also the step for moving the app to a new hostname, where every passkey
// stops working at once (CLAUDE.md).
//
// Ledger rows are not touched. Sessions are revoked, not deleted, so the
// record of where the account was signed in stays.
//
// Usage: npx tsx db/auth-reset.ts <env file> [--apply]
// Without --apply it runs inside a transaction, prints what it would change,
// and rolls back. It runs on the owner's machine with the owner's database
// credentials: there is no route or action for it. Against the production
// database (recognised by its fingerprint, lib/production-fingerprints.ts),
// --apply also asks for a typed phrase, so a wrong env file is not one flag
// away from locking the owner out; with no terminal to type into, it refuses.
const CONFIRMATION = 'forget every production passkey';
const args = process.argv.slice(2);
const envFile = args[0];
if (!envFile || envFile.startsWith('--')) throw new Error('Usage: npx tsx db/auth-reset.ts <env file> [--apply]');
const apply = args.includes('--apply');

const connectionString = parse(readFileSync(envFile)).DATABASE_URL;
if (!connectionString) throw new Error(`DATABASE_URL is not set in ${envFile}`);

class RolledBack extends Error {}

async function confirmProduction(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${envFile} is the PRODUCTION database. Every passkey will be forgotten and every session signed out.\n` +
        `Type "${CONFIRMATION}" to continue: `,
    );
    return answer.trim() === CONFIRMATION;
  } finally {
    rl.close();
  }
}

async function main() {
  if (apply && isProductionDatabaseUrl(connectionString) && !(await confirmProduction())) {
    console.log('Not confirmed; nothing changed.');
    return;
  }
  const sql = postgres(connectionString!, { prepare: false, max: 1, onnotice() {} });
  try {
    await sql.begin(async (tx) => {
      const [{ branch }] = await tx`select current_setting('neon.branch_id', true) as branch`;
      console.log(`${envFile}: branch=${branch}${apply ? '' : ' (preview, rolled back)'}`);
      const [before] = await tx`
        select (select count(*)::int from users) as users,
          (select count(*)::int from passkey_credentials) as passkeys,
          (select count(*)::int from sessions where revoked_at is null and expires_at > now()) as live_sessions`;
      console.log('before:', before);
      const passkeys = await tx`delete from passkey_credentials returning device_label`;
      const revoked = await tx`update sessions set revoked_at = now() where revoked_at is null returning id`;
      await tx`delete from auth_challenges`;
      console.log(`passkeys forgotten: ${passkeys.length} (${passkeys.map((p) => p.device_label).join(', ')})`);
      console.log(`sessions signed out: ${revoked.length}`);
      if (!apply) throw new RolledBack();
    });
    console.log('Done. Set a new AUTH_BOOTSTRAP_TOKEN in Vercel, then open /sign-in.');
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    console.log('Preview only; nothing changed. Run again with --apply.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
