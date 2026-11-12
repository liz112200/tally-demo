# Release checks in a browser

Decided 2026-11-12. The owner's release checklists were mostly DOM
assertions run by hand: does Sort show the rows the band counts, does Add
totals open a form with its date, is a duplicate closing date refused. Each
checklist was already the writing-down of what should be true, so it is run
as checks instead: `e2e/*.e2e.ts`, Playwright, against the local demo.

## Running them

`npm run e2e` (scripts/e2e-local.sh):

1. refuses while app, lib, db, e2e or the dependencies have uncommitted
   changes, since those would not be the code under test;
2. checks out the committed HEAD in the local demo's worktree
   (`TALLY_DEMO_WORKTREE`, default `../tally-demo-local`), installs its
   dependencies when the lockfile changed, and builds it;
3. resets the local demo (`DEMO_ENV=local npm run demo:reset`, DEMO.md);
4. serves the build on port 3100 and runs the checks against it. Playwright
   starts that server itself and fails if the port is taken, so the checks
   never run against a server of unknown build.

## The push gate

The checks cannot run in CI (they need Docker and the local demo's own Blob
store), so a rule that they are run would rest on a promise. Instead a push
to master is refused unless they passed on exactly the commit pushed:
`npm run e2e` records the commit it checked in the git directory
(`.git/e2e-passed`) after an unfiltered run passes, and `.githooks/pre-push`
compares. Any later commit, docs included, needs its own run. Other
branches deploy nothing and are not gated. `npm install` points git at
`.githooks` (the `prepare` script), and lib/push-gate.test.ts fails where
the hook is not installed. `git push --no-verify` skips any hook; it is not
used here.

The checks change the demo's data, so they run in order on one worker, and
the config refuses any address but localhost: never the public demo, never
production. Arguments pass to Playwright (`npm run e2e -- -g statement`).
A failure keeps a screenshot and a trace under `test-results/`.

## What they cover, and what they do not

They read everything from the page and know none of the demo's figures,
which move with the day. They assert what a checklist asked: counts, where a
link lands, which controls exist, refusals and their wording, and, at 390px,
that no page scrolls sideways and the new controls fit.

They do not judge whether a page reads clearly, whether wording will confuse
later, whether a layout looks right, or how a real phone handles touch,
fonts and the keyboard. A release still ends with a short list of those for
the owner. They also do not reach production data, bank sync against Plaid,
or anything the demo's synthetic data cannot produce (a real bank's quirks,
the owner's hidden imports); those stay with read-only queries and database
tests.

## Writing them

- Read a list in one pass, after the page settles (`settled`, `e2e/band.ts`).
  The demo's orientation panel used to appear after load and move everything
  below it, and a list read item by item while it appeared skipped a card.
  It is now rendered by the server (its dismissal is a cookie), and
  e2e/layout.e2e.ts fails if any checked page moves after loading, so a
  loaded page is a settled one. Waiting for the network to go quiet is not
  a condition: under heavy load it never resolved on a quiet page.
- Load a page by its address without a fragment when already on it: going
  to the same address plus `#statements` is a jump within the page and reads
  what was there before the action.
- A check asserts a minimum of what it found (three accounts, at least one
  band line opening Expenses), so it cannot pass without having looked.
- A new check is shown to fail against the code before the change it covers.
