#!/usr/bin/env bash
# Release checks in a browser (E2E.md). Builds the committed HEAD in the local
# demo's worktree, resets the local demo's data, serves it on port 3100 and
# runs e2e/ against it. Arguments go to Playwright (e.g. -g "statement").
set -euo pipefail
cd "$(dirname "$0")/.."
WT="${TALLY_DEMO_WORKTREE:-../tally-demo-local}"

# Uncommitted changes would not be the code under test, so a pass would
# describe something else.
if [ -n "$(git status --porcelain -- app lib db components e2e scripts package.json package-lock.json next.config.ts playwright.e2e.config.ts)" ]; then
  echo "Refusing: uncommitted changes would not be the code under test. Commit first." >&2
  exit 1
fi
HEAD=$(git rev-parse HEAD)
git -C "$WT" checkout -q --detach "$HEAD"
LOCK=$(shasum package-lock.json | cut -d' ' -f1)
if [ "$(cat "$WT/node_modules/.e2e-lock" 2>/dev/null)" != "$LOCK" ]; then
  (cd "$WT" && npm ci --no-audit --no-fund) && echo "$LOCK" > "$WT/node_modules/.e2e-lock"
fi
echo "Building $(git log --oneline -1 "$HEAD") in $WT"
(cd "$WT" && npx next build > /dev/null)
DEMO_ENV=local npm run demo:reset
echo "Checking $(git log --oneline -1 "$HEAD")"
E2E_SERVER_DIR="$WT" npx playwright test -c playwright.e2e.config.ts "$@"

# Passed (set -e stops on a failure). A filtered run is not the whole check,
# so only a full one is recorded for the push gate (.githooks/pre-push).
if [ "$#" -eq 0 ]; then
  printf '%s\n%s\n' "$HEAD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$(git rev-parse --git-path e2e-passed)"
  echo "Recorded: the browser checks passed on $(git log --oneline -1 "$HEAD")."
else
  echo "Not recorded for the push gate: a filtered run ($*)."
fi
