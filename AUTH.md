# Authentication (bank sync slice 6)

The app gets its own login before any real bank data exists (BANK-SYNC.md,
build order). One user today; nothing built here is torn out when a second
arrives.

## Scope

- One user, two or three devices. No registration, no password reset, no
  roles.
- A real user record behind every session from the start.
- Single-user behaviour now, shaped so a second user is an addition, not a
  rewrite.

## Method: passkeys (WebAuthn)

- **Why.** No password to store, leak or reset; phishing-resistant; bound
  to the app's hostname. Apple and Google sync a passkey across a user's
  devices, so the laptop and phone are usually one registration. No third
  party holds the identity or sees sign-ins, and there is no email provider
  to configure. Library: `@simplewebauthn/server` and `/browser` (verify,
  not implement, the WebAuthn ceremonies).
- **First passkey (bootstrap).** `AUTH_BOOTSTRAP_TOKEN` (random, set by the
  owner in Vercel, never in the repository) lets whoever presents it create
  the owner user and register a passkey, once: the token is refused once any
  credential exists. Compared in constant time.
- **More devices.** A signed-in device adds a passkey for the same user
  ("Add this device", or a cross-device QR from the browser's own passkey
  prompt). A device that cannot sync passkeys (a work laptop, an Android
  phone beside an iPhone) is one more registration, not a new account.
- **Recovery.** If every passkey is lost, rotating the token alone recovers
  nothing: setup refuses while any passkey row exists, and a lost passkey's
  row stays. So, from the owner's machine: `npm run auth:reset -- .env.local`
  (a preview), then with `--apply` (forgets every passkey, signs out every
  session, touches no ledger row); set a new `AUTH_BOOTSTRAP_TOKEN` in
  Vercel; open /sign-in. The new passkey attaches to the same user, so its
  link to the owner person is unchanged. The recovery factors are Vercel and
  the database credentials on the owner's machine. A copy of the setup token
  kept in the same password manager as the passkey is no backup: losing that
  manager is the case recovery exists for.
- **A second user, later.** An invitation: the signed-in owner creates a
  one-time, expiring invite link; the invitee registers a passkey with it and
  gets their own `users` row. That is one table (`invitations`) and one page;
  nothing built in this slice changes.
- **Considered and not chosen.** Sign in with Google (Auth.js): ties the
  ledger to a Google account and adds a framework for one user. Magic links:
  need an email provider and a reachable inbox per sign-in. A managed
  provider (Clerk): a third party holding identities and session data for a
  financial ledger. Password + TOTP: the reset flow this slice excludes.

## Data (migration 0026)

Passkeys also record the AAGUID their provider reports, so /devices names
where one lives (iCloud Keychain, Google Password Manager) instead of
reading the backup flag as "synced": Chrome and Safari on one Mac keep
passkeys in different managers, and neither offers the other's.


- `users`: id, display name, created_at, disabled_at, and `person_id`
  (nullable FK to `persons`): the owner user is linked to the owner person,
  so "who is signed in" and "whose balances these are" are one join, not an
  assumption.
- `passkey_credentials`: id (credential id), user_id, public key, sign
  count, transports, device label, created_at, last_used_at.
- `sessions`: sha256 of a 256-bit random token (the cookie holds the token,
  the database only its hash), user_id, created_at, expires_at (30 days,
  sliding), last_seen_at, user agent label, revoked_at.
- `auth_challenges`: WebAuthn challenges, single use, 5-minute expiry.
- No ledger table changes (see Multi-user shape).

## Enforcement

- **Every page and every Server Action checks the session server-side.**
  `requireUser()` (server-only) reads the cookie, looks up the session by
  hash, and returns the user or refuses. Server Actions call it inside
  `attempt`'s reach: `requireUser` redirects to /sign-in, and `attempt` lets
  Next's redirect through (`unstable_rethrow`), so an expired session is a
  navigation, never a crash. `lib/auth-convention.test.ts` enumerates every
  exported Server Action, every `page.tsx` and every `route.ts` from the
  filesystem and fails the build unless each checks the session as its first
  statement. The exceptions are named: the four sign-in actions and two
  public pages, and an exception that no longer exists fails too. It also
  checks that the pages it treats as public are exactly the paths proxy.ts
  lets through. Removing the check from one action on purpose fails it.
- **`proxy.ts` only redirects.** Unauthenticated page requests go to
  /sign-in. Next 16 documents proxy as an optimistic check, not
  authorization, so nothing relies on it alone.
- **Public by design:** /sign-in and its actions, `/s/[token]` (share
  snapshots, CLAUDE.md), static assets, and the cron route below.
- **Cookie:** `__Host-` prefixed, HttpOnly, Secure (not on localhost),
  SameSite=Lax, Path=/. Server Actions already reject cross-origin POSTs.
- **Sign out** (header) revokes the session row; /devices lists the
  passkeys and signed-in sessions, adds a passkey on the current device, and
  signs out any other session.

## Cron

The cron route (slice 5, deferred) is exempt from the session and requires
`Authorization: Bearer ${CRON_SECRET}`, compared in constant time; Vercel
Cron sends exactly that header. Vercel's own cron calls pass deployment
protection (tested 2026-10-19, BANK-SYNC.md). This slice adds the
exemption and a test that the route refuses a request without the secret
and accepts one with it, so slice 5 only adds the route's body.

## Demo and dev

- **Demo (`DEMO_MODE=1`)** stays public, with no sign-in: every request runs
  as a synthetic demo user held in memory (no row). The bypass is keyed on
  `DEMO_MODE=1`, which lib/deploy-guard.ts already forbids alongside any
  production credential, so it can never apply to the real ledger.
- **Dev** signs in like production (passkeys work on localhost), so the
  checks are exercised daily. The dev database gets its own owner user.

## Deployment protection

Stays on (All Deployments) as a second layer, as BANK-SYNC.md planned:
the app sits behind Vercel's login and then the passkey. Hobby has no team
members, so a second user could not pass Vercel's protection; turning it off
is the step taken when a second user is invited, by which time the app's own
auth has been in daily use. Turning it off changes no code.

## Multi-user shape

The repository has no `workspace_id` and no RLS today (CLAUDE.md: RLS
deferred). The ledger is one implicit workspace whose point of view is the
owner person (`persons.is_owner`): every balance is "owed to / by the
owner".

- **Shared workspace (several users, one ledger)** fits the schema as it
  is: a second user is another `users` row, optionally linked to an existing
  `persons` row. Ledger tables need no owner column. Left open by this slice.
- **Separate workspaces (one ledger per user)** needs real work: a
  `workspaces` table, `workspace_id` on the 16 tables (a one-value backfill,
  since there is one workspace, so not the painful part), every query and
  Server Action scoped by it, and the unique indexes made per workspace
  (dedup hash, the single-owner index, category and rule uniqueness), with
  RLS as a backstop. Adding the column now would not do the scoping, which
  is the work, so this slice does not add it.
- **What the shared door forecloses:** nothing structural. It does mean a
  second user sees the ledger from the owner's point of view (their own
  debts appear as "they owe the owner"), not their own; a per-user point of
  view is a modelling change to balances, needed under either future.

## Failure paths

- Expired or revoked session during an action: the action's error result
  says so; the page redirects to /sign-in on next navigation.
- WebAuthn verification fails (wrong device, counter regression): refused,
  logged without the credential; no session created.
- Bootstrap token wrong or already used: refused, with no hint which.
- Database unavailable at sign-in: the generic action error; no session.
- Clock skew: challenge and session expiry are compared in Postgres
  (`now()`), not the server's JS clock.

## Tests

- Unit: token hashing, cookie attributes, expiry, the public-route list,
  the structural `requireUser` test.
- Database: session create, slide, expire, revoke; challenge single use;
  bootstrap refused once a credential exists; an action called without a
  session returns the signed-out error and changes nothing; cron refuses
  without the secret.
- WebAuthn verification through the library on real ceremonies:
  db/test/virtual-authenticator.ts is a software passkey (a P-256 key, CBOR
  attestation, ES256 signatures), so the tests run the same verification as
  production, and can replay a counter, use a wrong origin, or answer with
  an unknown passkey.
- In a browser, 2026-10-27, Chrome with its built-in virtual authenticator
  against a dev server: no session redirects to /sign-in (keeping `next`);
  setup with the token; /devices lists the passkey and session; adding a
  passkey on a device that already holds one is refused; sign out; signing
  in returns to the page asked for; a device with no passkey is told to add
  one from a signed-in device. Not covered there: a real platform passkey
  (Touch ID, a phone), cross-device sign-in by QR, and synced passkeys,
  which the owner's checklist covers.

## Still open

- **Vercel's login in front of the app** is clunky on a phone, and on Hobby
  a second user could not pass it at all. Revisit when inviting someone:
  with the app's own sign-in in daily use, turning deployment protection off
  then is a settings change, no code.

- The check that Vercel's protection scope is still All Deployments
  (BANK-SYNC.md slice 6). Not in CI: a Vercel token is account-scoped, so one
  stored in GitHub Actions could read production's environment variables
  (AUTH_BOOTSTRAP_TOKEN now, the production Plaid secret from slice 7), the
  same objection that kept Neon keys out of tests. When built, it is a local
  pre-deploy script the owner runs with a token on their own machine.
- The cron route itself is slice 5; this slice adds its exemption and the
  `CRON_SECRET` check (`isCronRequest`), tested as a function.
