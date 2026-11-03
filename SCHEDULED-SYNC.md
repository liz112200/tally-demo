# Scheduled sync (bank sync slice 5)

Spec and build, 2026-11-03. A daily cron syncs every linked login, so the
owner no longer presses Sync now by hand (it stays, for an immediate sync),
and Expenses says plainly when an account has gone quiet and whether that
needs the owner.

## Decisions

- **Schedule.** Vercel Cron, `0 10 * * *` (10:00 UTC). Hobby runs it once
  a day, up to 59 minutes late, so it lands between 5:00 and 6:00 Eastern,
  after the overnight posting batch. Declared in `vercel.ts` for the app
  only; the demo keeps its own cron, the daily reset, and gets no scheduled
  sync.
- **Secret.** `CRON_SECRET`, generated and set by the owner in Vercel
  Production as Sensitive, with a copy in a password manager. The route
  compares it in constant time. `lib/env-manifest.ts` makes it required on
  the app, so a production build without it fails, naming it. It must
  exist before the deploy that adds the cron.
- **Plaid cost and limits** (checked 2026-11-03, below): Transactions is a
  monthly subscription per Item on paid plans, charged whether or not calls
  are made, and free on the Trial; `/transactions/sync` is limited to 50
  calls a minute per Item. A daily run makes one `/item/get` per login and
  one `/transactions/sync` page or more per enabled account.
  `/transactions/refresh`, the one Transactions endpoint billed per call, is
  never called.

## The run

`/api/cron/sync` (GET, as Vercel Cron calls it), running
`runScheduledSync` (app/_lib/scheduled-sync.ts), whose loop is the pure
`syncInTurn` (lib/bank-sync/scheduled.ts). The per-login sync moved out of
the Server Actions file into app/_lib/bank-run.ts, shared by Sync now and
the cron and not callable from the browser:

1. Refuses without `Authorization: Bearer <CRON_SECRET>`, before anything
   else (the cron path is exempt from the session; lib/auth-convention.test.ts
   lists it).
2. Loads every active, unpaused connection with at least one enabled
   account; removed and paused logins are skipped, as Sync now skips them.
3. Syncs them one at a time through the same `syncAccounts` as Sync now
   (health first, then each account through the real commit), each inside
   its own try/catch: one login failing, or its bank being down, never stops
   the others. A sync already running (someone pressed Sync now) is the
   commit's ordinary refusal, not a failure.
4. Stops starting new logins at a deadline inside the function's 300 s;
   any not reached are synced the next day and show as stale if that
   repeats.
5. Logs one line per login, never a token, query or amount, and returns a
   200 with the per-login outcome so Vercel's cron log shows it.
6. Is a 404 on the demo, after the secret check: the demo has no scheduled
   sync.

## What "no changes" means

`/transactions/sync` returns what Plaid has already fetched; Plaid checks
each bank one to four times a day on its own schedule. A second sync soon
after another, by hand or by the cron, therefore usually brings nothing, and
that is normal. /accounts says so under its heading.

Nothing new is stored: `last_synced_at`, `last_sync_error` (per account) and
the login's health (per connection) already record what happened.

## The stale line on Expenses

Shown when any enabled account on an unpaused login has not synced for 36
hours, one line per account, naming the account and saying which case it is:

- **Needs you.** The login's health is `reconnect`, `fix_at_bank`, `gone` or
  an unknown code (ITEM_LOGIN_REQUIRED and the rest in
  lib/bank-sync/item-health.ts). Worded as something to do today: "Amex
  ••1234 has not synced since Nov 1: the bank wants you to sign in again.
  Reconnect on Accounts." It will not fix itself.
- **Probably transient.** The bank is unavailable (`INSTITUTION_DOWN` and
  its kin), or the account's last sync failed with a healthy login (a
  network error, the time budget). Worded as wait-and-see: "Chase ••1234
  has not synced since Nov 1: the bank was not answering. The next daily
  sync retries; look again if this is still here tomorrow."
- **Not run.** Healthy login, no error, and still nothing for 36 hours: the
  scheduled sync itself did not run (a missing secret, a failed deploy).
  "No scheduled sync has run since Nov 1." This case is the cron's own
  failure, which neither of the others would show.

The wording comes from one pure function over (health, last error, last
synced, now), tested case by case.

**In-app and delayed, deliberately** (owner's decision, 2026-11-03). The
only signal that the daily sync has stopped is this line, it appears 36
hours after the last sync, and it is seen only when the owner opens
Expenses. If the app is not opened for a week, a broken cron is silent for
a week. That is accepted, not overlooked: no email, push or other outside
alert is built, and none should be added without the owner asking.

## Tests

- db/cron-sync.dbtest.ts: the route refuses a missing or wrong secret, a
  secret without its Bearer prefix, and any request when no secret is
  configured, running nothing; it is a 404 on the demo even with the
  secret; with the secret it runs the daily sync once.
- lib/bank-sync/scheduled.test.ts: one login throwing or failing does not
  stop the next; a paused login is reported skipped; no login starts after
  the deadline, and the ones left are named.
- db/demo-bank.dbtest.ts: the runner over the synthetic bank syncs every
  active login through the real commit, in /accounts order, and skips a
  paused one. (Two syncs at once were already covered: one applies.)
- lib/bank-sync/staleness.test.ts: each case, exactly 36 hours, and what is
  left out (sync off, paused, removed, unshared, never synced).

## Found while building

The demo's reset route compared the cron secret with `!==`: not constant
time, and with no minimum length. It now uses `isCronRequest`, as the sync
route does. No other route compares a secret.

## Plaid, as checked 2026-11-03

From Plaid's billing docs: the Trial is free with real production data, 10
Production Items, removal does not return a slot; Transactions (except
`/transactions/refresh`) is billed per Item per month, "even if no API calls
are made". From the rate-limit docs: `/transactions/sync` 50 per minute per
Item, 2,500 per minute per client; `/item/get` 15 per minute per Item.
Plaid refreshes an Item's transactions one to four times a day on its own
schedule; `/transactions/sync` returns what it has stored. Not found in the
docs: any call or refresh limit specific to the Trial. Plaid's support
article on how the Trial differs could not be read from here (it refused the
request), so whether it says more is open.
