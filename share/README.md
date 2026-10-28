# share

The public face of the snapshots created on /people. Deployed as its own
Vercel project, from this directory, with deployment protection **off** —
while the main app keeps protection **on**.

That split is the point. The app holds a private ledger and stays behind
Vercel's login wall; a share link has to be openable by someone with no
Vercel account. Serving both from one deployment would mean either exposing
the ledger or breaking the links.

Isolation is structural, not configured: this project declares only the
`share_links` table (see `db.ts`), has no route but `/s/[token]` and a dead
end at `/`, and so cannot serve a transaction, split, or person even if
misconfigured. Trimming a shared link back to the domain reveals nothing.

`lib/money.ts` is imported from the parent app rather than copied
(`experimental.externalDir`), because the money scale has already widened
once — from cents to mills — and a duplicated formatter would have gone on
silently rendering the old scale here.

## Deploying

A second Vercel project on the same repository:

- **Root Directory**: `share`, with "Include source files outside of the Root
  Directory" enabled (it imports `../lib/money.ts`).
- **Environment**: `DATABASE_URL` — the same database as the app.
- **Deployment Protection**: disabled, for Production and Preview.

Then set `NEXT_PUBLIC_SHARE_BASE_URL` on the *main* project to this
project's domain, so share links are built against it.

Migrations are owned by the parent app and are never run from here.
