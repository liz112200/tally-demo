// Which site passkeys belong to (AUTH.md). Pure: configuration is passed in.
//
// A passkey is bound to its relying party id, a hostname. In production that
// is the project's stable production hostname, which Vercel provides as
// VERCEL_PROJECT_PRODUCTION_URL (the custom domain once one is added, else
// the project's .vercel.app name). Changing it, by adding a custom domain,
// strands every passkey: they are re-registered with the bootstrap token
// (CLAUDE.md). Locally it is localhost.
export type RelyingParty = { rpID: string; origin: string; rpName: string };

export function relyingParty(env: Readonly<Record<string, string | undefined>>): RelyingParty {
  const rpName = 'Tally';
  if (env.VERCEL_ENV === 'production') {
    const host = env.VERCEL_PROJECT_PRODUCTION_URL;
    if (!host) throw new Error('VERCEL_PROJECT_PRODUCTION_URL is not set; passkeys need a stable hostname');
    return { rpID: host, origin: `https://${host}`, rpName };
  }
  if (env.VERCEL_ENV === 'preview') {
    // A preview's hostname changes per deployment, so no passkey could last;
    // previews are not signed into (deployment protection covers them).
    throw new Error('Sign-in is not available on preview deployments.');
  }
  const origin = env.AUTH_ORIGIN ?? 'http://localhost:3000';
  return { rpID: new URL(origin).hostname, origin, rpName };
}
