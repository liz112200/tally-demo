# Demo deployment

The public demo is the app itself, built from this repository as a third
Vercel project (`tally-demo`) with `DEMO_MODE=1`. It runs on synthetic data
in its own Neon database and Vercel Blob store. Production is untouched: no
migration, no shared credential, no shared store.

## What differs in demo mode

- A banner states that the data is synthetic and resets daily, links to the
  source, and offers Reset. A first-visit strip points at three things to try.
- Expenses gains "Import a sample statement", which runs the real import
  preview on a generated Discover CSV whose oldest rows are already imported.
- Receipt extraction is simulated; Gemini is never called and no key is set.
- People shows the same Simplify card as production.

## Isolation

Two independent checks keep a demo deployment off production's stores:

1. `lib/deploy-guard.ts`, offline: a demo deployment fails at build
   (`next.config.ts`) and before any connection (`db/index.ts`) if its
   database endpoint or Blob store fingerprint is listed in
   `lib/production-fingerprints.ts`, if it holds `GEMINI_API_KEY`, or if its
   production URL names tally-demo but `DEMO_MODE` is unset.
2. `db/demo-guard.ts`, network: the build and every reset require the
   database comment `tally-demo` and the Blob object
   `_tally/demo-store-marker.txt`. Only `npm run demo:mark` writes them, and
   it refuses any store that already holds data.

Fill `lib/production-fingerprints.ts` once by running
`npm run guard:fingerprint` with production's environment loaded; it prints
hashes only.

## Provisioning

1. Create the Vercel project `tally-demo` on this repository (root directory
   `.`). Keep Standard Protection: the production domain is public, previews
   are not.
2. Add a NEW Neon database from the Marketplace, connected to `tally-demo`
   only. Never branch from production: a branch is a copy of its data.
3. Create a private Blob store connected to `tally-demo` only.
4. Set `DEMO_MODE=1` and `CRON_SECRET` on Production and Preview. Do not set
   `GEMINI_API_KEY`.
5. Put the demo's `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` in `.env.demo`
   (gitignored), then:

   ```sh
   npm run demo:mark -- <neon-endpoint-id>   # from DATABASE_URL's host
   npm run demo:migrate
   npm run demo:reset
   ```

   Never run `npm run db:migrate` for the demo: `drizzle.config.ts` reads
   `.env.local`, which is production.

## Resets

`db/demo-reset.ts` rebuilds everything for today's date. It runs from the
daily cron (`/api/demo/reset`, 09:00 UTC, declared in `vercel.ts` for demo
deployments only), from the banner, and from `npm run demo:reset`. New
receipt images upload first, the wipe and inserts commit as one transaction,
and the previous images are deleted afterwards.
