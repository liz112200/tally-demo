import 'server-only';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { authChallenges, passkeyCredentials, persons, sessions, users } from './schema';
import { SESSION_DAYS, SESSION_SLIDE_AFTER_HOURS } from '@/lib/auth/session-token';

// Users, passkeys, sessions and WebAuthn challenges (AUTH.md). Every expiry
// is judged by Postgres's clock (now()), never the server's.

export type SignedInUser = { id: string; displayName: string; personId: string | null; sessionId: string };

export type StoredPasskey = {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[] | null;
  deviceLabel: string;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
};

const toText = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
// A fresh ArrayBuffer-backed copy: the verifier's types do not accept a
// view of Node's shared Buffer pool.
const fromText = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = Buffer.from(text, 'base64url');
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
};

// ---- Challenges ----

export async function createChallenge(input: {
  challenge: string;
  purpose: 'bootstrap' | 'add_device' | 'sign_in';
  userId: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(authChallenges)
    .values({ ...input, expiresAt: sql`now() + interval '5 minutes'` })
    .returning({ id: authChallenges.id });
  return row.id;
}

// Single use: the challenge is deleted as it is read. Null when it does not
// exist, was already used, has expired, or belongs to another ceremony.
export async function consumeChallenge(
  id: string,
  purpose: 'bootstrap' | 'add_device' | 'sign_in',
): Promise<{ challenge: string; userId: string | null } | null> {
  const [row] = await db
    .delete(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.purpose, purpose), sql`${authChallenges.expiresAt} > now()`))
    .returning({ challenge: authChallenges.challenge, userId: authChallenges.userId });
  return row ?? null;
}

// ---- Passkeys and users ----

export async function credentialCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(passkeyCredentials);
  return Number(row.n);
}

type NewPasskey = {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | undefined;
  deviceLabel: string;
  deviceType: string;
  backedUp: boolean;
  aaguid: string;
};

const passkeyRow = (userId: string, p: NewPasskey) => ({
  id: p.id,
  userId,
  publicKey: toText(p.publicKey),
  counter: p.counter,
  transports: p.transports ?? null,
  deviceLabel: p.deviceLabel,
  deviceType: p.deviceType,
  backedUp: p.backedUp,
  aaguid: p.aaguid,
});

// The owner's first passkey: refused once any passkey exists, under a lock so
// two attempts at once cannot both pass. The first time it creates the user,
// linked to the ledger's owner person. After a recovery reset
// (db/auth-reset.ts) the owner's user already exists, and the passkey
// attaches to it, so the user and its link stay as they were; the name typed
// then is not applied.
export async function bootstrapOwner(input: { displayName: string; passkey: NewPasskey }): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('tally.auth.bootstrap', 0))`);
    const [{ n }] = await tx.select({ n: count() }).from(passkeyCredentials);
    if (Number(n) > 0) return null;
    const [owner] = await tx.select({ id: persons.id }).from(persons).where(eq(persons.isOwner, true));
    const [existing] = owner
      ? await tx.select({ id: users.id }).from(users).where(eq(users.personId, owner.id)).orderBy(asc(users.createdAt))
      : [];
    const userId =
      existing?.id ??
      (
        await tx
          .insert(users)
          .values({ displayName: input.displayName, personId: owner?.id ?? null })
          .returning({ id: users.id })
      )[0].id;
    await tx.insert(passkeyCredentials).values(passkeyRow(userId, input.passkey));
    return userId;
  });
}

export async function addPasskey(userId: string, passkey: NewPasskey): Promise<void> {
  await db.insert(passkeyCredentials).values(passkeyRow(userId, passkey));
}

export async function getPasskey(id: string): Promise<(StoredPasskey & { userId: string }) | null> {
  const [row] = await db
    .select()
    .from(passkeyCredentials)
    .innerJoin(users, eq(users.id, passkeyCredentials.userId))
    .where(and(eq(passkeyCredentials.id, id), isNull(users.disabledAt)));
  if (!row) return null;
  const p = row.passkey_credentials;
  return {
    id: p.id,
    userId: p.userId,
    publicKey: fromText(p.publicKey),
    counter: p.counter,
    transports: p.transports,
    deviceLabel: p.deviceLabel,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    aaguid: p.aaguid,
  };
}

export async function getUserPasskeys(userId: string): Promise<StoredPasskey[]> {
  const rows = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, userId))
    .orderBy(asc(passkeyCredentials.createdAt));
  return rows.map((p) => ({
    id: p.id,
    publicKey: fromText(p.publicKey),
    counter: p.counter,
    transports: p.transports,
    deviceLabel: p.deviceLabel,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    aaguid: p.aaguid,
  }));
}

// After a verified sign-in: the authenticator's new counter, and when.
export async function recordPasskeyUse(id: string, counter: number): Promise<void> {
  await db
    .update(passkeyCredentials)
    .set({ counter, lastUsedAt: sql`now()` })
    .where(eq(passkeyCredentials.id, id));
}

export async function getUserDisplayName(userId: string): Promise<string | null> {
  const [row] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  return row?.displayName ?? null;
}

// ---- Sessions ----

export async function createSession(input: { userId: string; tokenHash: string; userAgent: string | null }): Promise<void> {
  await db.insert(sessions).values({
    userId: input.userId,
    tokenHash: input.tokenHash,
    userAgent: input.userAgent,
    expiresAt: sql`now() + make_interval(days => ${SESSION_DAYS})`,
  });
}

// The signed-in user for a token's hash: a session that is not revoked or
// expired, of a user who is not disabled. Slides the expiry when the session
// was last seen more than a day ago.
export async function sessionUser(tokenHash: string): Promise<SignedInUser | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      displayName: users.displayName,
      personId: users.personId,
      stale: sql<boolean>`${sessions.lastSeenAt} < now() - make_interval(hours => ${SESSION_SLIDE_AFTER_HOURS})`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        isNull(users.disabledAt),
      ),
    );
  if (!row) return null;
  if (row.stale) {
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now()`, expiresAt: sql`now() + make_interval(days => ${SESSION_DAYS})` })
      .where(eq(sessions.id, row.sessionId));
  }
  return { id: row.id, displayName: row.displayName, personId: row.personId, sessionId: row.sessionId };
}

// Revokes one of the user's sessions; false when it is not theirs or is
// already revoked.
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length > 0;
}

export type SessionRow = { id: string; createdAt: Date; lastSeenAt: Date; userAgent: string | null };

export async function activeSessions(userId: string): Promise<SessionRow[]> {
  return db
    .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
    .orderBy(desc(sessions.lastSeenAt));
}
