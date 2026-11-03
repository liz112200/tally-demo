# Demo deployment

The public demo is the app itself, deployed as a third Vercel project
(`tally-demo`) with `DEMO_MODE=1`. It builds from the public snapshot
repository liz112200/tally-demo — the same code with synthetic test fixtures
and no history. A GitHub Action in the private repository rebuilds that
snapshot on every push to master (`npm run snapshot -- <dir>` builds it
locally) and pushes it, which redeploys the demo. The Action authenticates
with a write deploy key on the public repository, stored as the private
repository's `PUBLIC_SNAPSHOT_DEPLOY_KEY` secret. It runs on synthetic data
in its own Neon database and Vercel Blob store. Production is untouched: no
migration, no shared credential, no shared store.

## What differs in demo mode

- A banner states that the data is synthetic and resets daily, links to the
  source, and offers Reset. A first-visit strip points at four things to try:
  syncing a bank, checking an account against its statement, splitting a
  dinner, and simplifying balances.
- Expenses gains "Import a sample statement", which runs the real import
  preview on a generated Discover CSV whose oldest rows are already imported.
- /accounts shows two synthetic bank logins, Chase checking and Amex, served
  by the synthetic provider through the real sync code (DEMO-SYNC.md): Sync
  now, the boundary review with a held row, and the statement check work;
  linking and managing a login do not.
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

1. Create the Vercel project `tally-demo` on the public snapshot repository
   (root directory `.`). Keep Standard Protection: the production domain is public, previews
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

## Local demo

Demo changes are checked in a browser against stores of their own, never
tally-demo's. The guard is the same: both markers, written only by
`demo:mark` into empty stores.

1. A Blob store of its own, created empty in the Vercel dashboard and
   connected to no project. A reset uploads receipt images, so there is no
   way around a real store.
2. `.env.demo-local` (gitignored) with that store's `BLOB_READ_WRITE_TOKEN` and
   `DATABASE_URL=postgres://tally:tally@127.0.0.1:55532/tally_demo_local`.
3. Then:

   ```sh
   docker compose -f docker-compose.demo-local.yml up -d --wait
   DEMO_ENV=local npm run demo:mark -- 127
   DEMO_ENV=local npm run demo:migrate
   DEMO_ENV=local npm run demo:reset
   ```

4. Run `next dev` with `DEMO_MODE=1` in a separate worktree whose only env
   file is a copy of `.env.demo-local`. In the main checkout, `.env.local`
   holds the bank and Gemini credentials the guard refuses in demo mode, so
   a demo-mode server there does not start.

The demo scripts read `.env.demo` unless `DEMO_ENV=local`, and no other file
(lib/demo/env-file.ts).
