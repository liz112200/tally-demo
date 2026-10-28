// Slice 6 (AUTH.md): passkeys, sessions, and every action refusing without
// one. The passkeys are real: a software authenticator (db/test/
// virtual-authenticator.ts) answers each ceremony, and @simplewebauthn
// verifies it as in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { passkeyCredentials, persons, sessions, users } from './schema';
import { consumeChallenge, createChallenge, sessionUser } from './auth';
import { owner, person } from './test/fixtures';
import { testRequest } from './test/request';
import { VirtualAuthenticator } from './test/virtual-authenticator';
import { hashSessionToken } from '@/lib/auth/session-token';
import {
  beginAddDevice,
  beginBootstrap,
  beginSignIn,
  finishAddDevice,
  finishBootstrap,
  finishSignIn,
  revokeOtherSession,
  signOut,
} from '@/app/_actions/auth';
import { deletePerson } from '@/app/_actions/people';
import { currentUser } from '@/app/_lib/session';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const TOKEN = 'a-long-bootstrap-token-for-tests';

// Where a redirect from an action goes; Next throws it as an error whose
// digest carries the target.
async function redirectOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2];
    throw err;
  }
  throw new Error('expected a redirect');
}

const sessionToken = () => testRequest.cookies.get('tally_session')?.value ?? null;
const signedOut = () => testRequest.cookies.delete('tally_session');

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await run();
  } finally {
    vi.restoreAllMocks();
  }
}

// The owner bootstrapped with a passkey, signed in; returns the passkey.
async function bootstrapped(): Promise<{ key: VirtualAuthenticator; userId: string }> {
  await db.delete(passkeyCredentials);
  vi.stubEnv('AUTH_BOOTSTRAP_TOKEN', TOKEN);
  const key = new VirtualAuthenticator();
  const begun = await beginBootstrap(TOKEN);
  if ('error' in begun) throw new Error(begun.error);
  expect(await redirectOf(finishBootstrap(begun.challengeId, key.register(begun.options), 'Linh'))).toBe('/');
  const user = await currentUser();
  return { key, userId: user!.id };
}

beforeEach(() => {
  vi.stubEnv('AUTH_ORIGIN', 'http://localhost:3000');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('without a session', () => {
  it('an action changes nothing and goes to /sign-in, as does an expired, revoked or disabled one', async () => {
    const id = await person('Untouched');
    const fd = new FormData();
    fd.set('id', id);
    const cases: [string, () => void][] = [
      ['no cookie', () => void signedOut()],
      ['unknown token', () => void testRequest.cookies.set('tally_session', { name: 'tally_session', value: 'forged' })],
    ];
    for (const [, setUp] of cases) {
      setUp();
      expect(await redirectOf(deletePerson(fd))).toBe('/sign-in');
    }
    const [row] = await db.select({ deletedAt: persons.deletedAt }).from(persons).where(eq(persons.id, id));
    expect(row.deletedAt).toBeNull();
  });

  it('a session that is revoked, expired, or whose user is disabled is not a session', async () => {
    const { userId } = await bootstrapped();
    const hash = hashSessionToken(sessionToken()!);
    expect(await sessionUser(hash)).toMatchObject({ id: userId });

    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(sessions.tokenHash, hash));
    expect(await sessionUser(hash)).toBeNull();
    await db.update(sessions).set({ expiresAt: sql`now() + interval '1 day'` }).where(eq(sessions.tokenHash, hash));
    await db.update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, userId));
    expect(await sessionUser(hash)).toBeNull();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
    await db.update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.tokenHash, hash));
    expect(await sessionUser(hash)).toBeNull();
  });

  it('a session last seen over a day ago slides its expiry forward', async () => {
    await bootstrapped();
    const hash = hashSessionToken(sessionToken()!);
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '2 days'`, expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.tokenHash, hash));
    await sessionUser(hash);
    const [s] = await db
      .select({ days: sql<number>`extract(day from ${sessions.expiresAt} - now())::int` })
      .from(sessions)
      .where(eq(sessions.tokenHash, hash));
    expect(s.days).toBeGreaterThanOrEqual(29);
  });
});

describe('the first passkey', () => {
  it('is created with the setup token, linked to the owner person, and signs in', async () => {
    const ownerId = await owner();
    const { userId } = await bootstrapped();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({ displayName: 'Linh', personId: ownerId });
    const [passkey] = await db.select().from(passkeyCredentials).where(eq(passkeyCredentials.userId, userId));
    expect(passkey.deviceLabel).toBe('Mac · Chrome');
    // The software passkey reports no provider, as some real ones do.
    expect(passkey.aaguid).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('after a recovery reset, attaches to the same user, whose old sessions no longer work', async () => {
    const { userId } = await bootstrapped();
    const oldToken = sessionToken()!;
    // What db/auth-reset.ts does.
    await db.delete(passkeyCredentials);
    await db.update(sessions).set({ revokedAt: sql`now()` });
    signedOut();
    const key = new VirtualAuthenticator();
    const begun = await beginBootstrap(TOKEN);
    if ('error' in begun) throw new Error(begun.error);
    await redirectOf(finishBootstrap(begun.challengeId, key.register(begun.options), 'Someone else'));
    expect((await currentUser())?.id).toBe(userId);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.displayName).toBe('Linh');
    testRequest.cookies.set('tally_session', { name: 'tally_session', value: oldToken });
    expect(await currentUser()).toBeNull();
  });

  it('is refused with a wrong or missing token, and once any passkey exists', async () => {
    await db.delete(passkeyCredentials);
    vi.stubEnv('AUTH_BOOTSTRAP_TOKEN', TOKEN);
    expect(await beginBootstrap('wrong-token-of-some-length')).toEqual({ error: 'That token does not set up this app.' });
    vi.stubEnv('AUTH_BOOTSTRAP_TOKEN', '');
    expect(await beginBootstrap('')).toEqual({ error: 'That token does not set up this app.' });

    await bootstrapped();
    expect(await beginBootstrap(TOKEN)).toEqual({ error: 'This app is already set up. Sign in with a passkey.' });
  });

  it('two bootstraps racing: one wins, the other is refused after its passkey verified', async () => {
    await db.delete(passkeyCredentials);
    vi.stubEnv('AUTH_BOOTSTRAP_TOKEN', TOKEN);
    const a = await beginBootstrap(TOKEN);
    const b = await beginBootstrap(TOKEN);
    if ('error' in a || 'error' in b) throw new Error('begin failed');
    const results = await Promise.allSettled([
      finishBootstrap(a.challengeId, new VirtualAuthenticator().register(a.options), 'A'),
      finishBootstrap(b.challengeId, new VirtualAuthenticator().register(b.options), 'B'),
    ]);
    const refused = results.filter((r) => r.status === 'fulfilled');
    expect(refused).toEqual([{ status: 'fulfilled', value: { error: 'This app is already set up. Sign in with a passkey.' } }]);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(passkeyCredentials);
    expect(n).toBe(1);
  });
});

describe('signing in', () => {
  it('with the registered passkey starts a session and lands where asked, on this site only', async () => {
    const { key, userId } = await bootstrapped();
    signedOut();
    const begun = await beginSignIn();
    if ('error' in begun) throw new Error(begun.error);
    expect(await redirectOf(finishSignIn(begun.challengeId, key.authenticate(begun.options), '/people'))).toBe('/people');
    expect((await currentUser())?.id).toBe(userId);

    const again = await beginSignIn();
    if ('error' in again) throw new Error(again.error);
    expect(await redirectOf(finishSignIn(again.challengeId, key.authenticate(again.options), '//evil.example'))).toBe('/');
  });

  it('refuses a replayed counter, a wrong origin, an unknown passkey and a used challenge', async () => {
    const { key } = await bootstrapped();
    signedOut();
    const fail = { error: 'That passkey could not sign you in. Try again.' };
    const sign = async (answer: (o: { challenge: string }) => unknown) => {
      const begun = await beginSignIn();
      if ('error' in begun) throw new Error(begun.error);
      return { begun, result: await quietly(() => finishSignIn(begun.challengeId, answer(begun.options), '/')) };
    };
    // A first good sign-in sets the stored counter.
    const ok = await beginSignIn();
    if ('error' in ok) throw new Error(ok.error);
    await redirectOf(finishSignIn(ok.challengeId, key.authenticate(ok.options), '/'));
    signedOut();

    expect((await sign((o) => key.authenticate(o, { signCount: 1 }))).result).toEqual(fail);
    expect((await sign((o) => key.authenticate(o, { origin: 'https://evil.example' }))).result).toEqual(fail);
    expect((await sign((o) => new VirtualAuthenticator().authenticate(o))).result).toEqual(fail);
    expect(sessionToken()).toBeNull();

    const used = await beginSignIn();
    if ('error' in used) throw new Error(used.error);
    await redirectOf(finishSignIn(used.challengeId, key.authenticate(used.options), '/'));
    expect(await finishSignIn(used.challengeId, key.authenticate(used.options), '/')).toEqual({
      error: 'The sign-in took too long or was already used. Try again.',
    });
  });
});

describe('challenges', () => {
  it('are single use, expire, and belong to one ceremony', async () => {
    const id = await createChallenge({ challenge: 'c1', purpose: 'sign_in', userId: null });
    expect(await consumeChallenge(id, 'bootstrap')).toBeNull();
    expect(await consumeChallenge(id, 'sign_in')).toEqual({ challenge: 'c1', userId: null });
    expect(await consumeChallenge(id, 'sign_in')).toBeNull();
    const old = await createChallenge({ challenge: 'c2', purpose: 'sign_in', userId: null });
    await db.execute(sql`update auth_challenges set expires_at = now() - interval '1 second' where id = ${old}`);
    expect(await consumeChallenge(old, 'sign_in')).toBeNull();
  });
});

describe('devices and sessions', () => {
  it('a signed-in owner adds a second passkey, which then signs in on its own', async () => {
    const { userId } = await bootstrapped();
    const phone = new VirtualAuthenticator();
    const begun = await beginAddDevice();
    if ('error' in begun) throw new Error(begun.error);
    expect(begun.options.excludeCredentials).toHaveLength(1);
    expect(await finishAddDevice(begun.challengeId, phone.register(begun.options))).toEqual({
      ok: true,
      message: 'Passkey added for Mac · Chrome. It can sign in from now on.',
    });
    signedOut();
    const signIn = await beginSignIn();
    if ('error' in signIn) throw new Error(signIn.error);
    await redirectOf(finishSignIn(signIn.challengeId, phone.authenticate(signIn.options), '/'));
    expect((await currentUser())?.id).toBe(userId);
  });

  it('another session can be signed out from here; this one only by signing out', async () => {
    const { key } = await bootstrapped();
    const laptop = sessionToken()!;
    signedOut();
    const begun = await beginSignIn();
    if ('error' in begun) throw new Error(begun.error);
    await redirectOf(finishSignIn(begun.challengeId, key.authenticate(begun.options), '/'));
    const phone = (await currentUser())!;
    testRequest.cookies.set('tally_session', { name: 'tally_session', value: laptop });
    const here = (await currentUser())!;

    expect(await revokeOtherSession(here.sessionId)).toEqual({ error: 'This is the session you are using; sign out instead.' });
    expect(await revokeOtherSession(phone.sessionId)).toEqual({ ok: true, message: 'Signed out on that device.' });
    expect(await revokeOtherSession(phone.sessionId)).toEqual({ error: 'That session was not found, or is already signed out.' });

    expect(await redirectOf(signOut())).toBe('/sign-in');
    expect(sessionToken()).toBeNull();
    testRequest.cookies.set('tally_session', { name: 'tally_session', value: laptop });
    expect(await currentUser()).toBeNull();
  });
});

describe('the demo', () => {
  it('needs no sign-in, and offers none', async () => {
    signedOut();
    vi.stubEnv('DEMO_MODE', '1');
    expect(await currentUser()).toMatchObject({ id: 'demo', displayName: 'Demo' });
    expect(await beginSignIn()).toEqual({ error: 'Sign-in is not used in the demo.' });
  });
});
