'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  addPasskey,
  bootstrapOwner,
  consumeChallenge,
  createChallenge,
  credentialCount,
  getPasskey,
  getUserDisplayName,
  getUserPasskeys,
  recordPasskeyUse,
  revokeSession,
} from '@/db/auth';
import type { ActionResult } from '@/lib/action-result';
import { isBootstrapToken } from '@/lib/auth/session-token';
import { deviceLabel } from '@/lib/auth/device-label';
import { relyingParty } from '@/lib/auth/relying-party';
import { isDemoMode } from '@/lib/demo-mode';
import { clearSessionCookie, requireUser, startSession } from '@/app/_lib/session';
import { attempt } from './attempt';

// Passkey sign-in, the one-time bootstrap, adding a device, signing out and
// revoking a session (AUTH.md). The four sign-in actions are the only Server
// Actions that run without a session (lib/auth-convention.test.ts).
// Verification is @simplewebauthn's; every challenge is single use and
// expires in five minutes, both judged in Postgres.

type Begin<T> = { options: T; challengeId: string } | { error: string };

const NOT_IN_DEMO = 'Sign-in is not used in the demo.';
// One message for every failed sign-in, so a refusal says nothing about why.
const SIGN_IN_FAILED = 'That passkey could not sign you in. Try again.';

const challengeIdSchema = z.string().uuid();
// Where to land after signing in: a path on this site only, never another.
const nextPathSchema = z
  .string()
  .regex(/^\/(?!\/)[^\s\\]*$/)
  .catch('/');

async function currentDeviceLabel(): Promise<string> {
  return deviceLabel((await headers()).get('user-agent'));
}

// ---- Signing in ----

export async function beginSignIn(): Promise<Begin<PublicKeyCredentialRequestOptionsJSON>> {
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const result = await attempt('beginSignIn', async () => {
    const rp = relyingParty(process.env);
    // No allowCredentials: the browser offers the passkeys it holds for this
    // site, and the one chosen names its user.
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
    const challengeId = await createChallenge({ challenge: options.challenge, purpose: 'sign_in', userId: null });
    return { ok: true as const, options, challengeId };
  });
  return 'error' in result ? result : { options: result.options, challengeId: result.challengeId };
}

export async function finishSignIn(challengeId: unknown, response: unknown, next: unknown): Promise<ActionResult> {
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = challengeIdSchema.safeParse(challengeId);
  if (!id.success) return { error: SIGN_IN_FAILED };
  const result = await attempt('finishSignIn', async () => {
    const challenge = await consumeChallenge(id.data, 'sign_in');
    if (!challenge) return { error: 'The sign-in took too long or was already used. Try again.' };
    const answer = response as AuthenticationResponseJSON;
    const passkey = typeof answer?.id === 'string' ? await getPasskey(answer.id) : null;
    if (!passkey) return { error: SIGN_IN_FAILED };
    const rp = relyingParty(process.env);
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: answer,
        expectedChallenge: challenge.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports ?? undefined,
        },
      });
    } catch (err) {
      console.error(`finishSignIn: verification refused (${err instanceof Error ? err.name : 'error'})`);
      return { error: SIGN_IN_FAILED };
    }
    if (!verified.verified) return { error: SIGN_IN_FAILED };
    await recordPasskeyUse(passkey.id, verified.authenticationInfo.newCounter);
    await startSession(passkey.userId);
    return { ok: true as const };
  });
  if ('error' in result) return result;
  redirect(nextPathSchema.parse(next));
}

// ---- The first passkey ----

// Only while no passkey exists, and only for whoever holds
// AUTH_BOOTSTRAP_TOKEN (set in Vercel by the owner, never in the repository).
// The challenge id becomes the new user's id, so the user handle stored in
// the passkey is the user's id from the first.
export async function beginBootstrap(token: unknown): Promise<Begin<PublicKeyCredentialCreationOptionsJSON>> {
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const given = z.string().max(500).safeParse(token);
  if (!given.success || !isBootstrapToken(given.data, process.env.AUTH_BOOTSTRAP_TOKEN)) {
    return { error: 'That token does not set up this app.' };
  }
  const result = await attempt('beginBootstrap', async () => {
    if ((await credentialCount()) > 0) return { error: 'This app is already set up. Sign in with a passkey.' };
    const rp = relyingParty(process.env);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: 'owner',
      userDisplayName: 'Owner',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await createChallenge({ challenge: options.challenge, purpose: 'bootstrap', userId: null });
    return { ok: true as const, options, challengeId };
  });
  return 'error' in result ? result : { options: result.options, challengeId: result.challengeId };
}

export async function finishBootstrap(challengeId: unknown, response: unknown, displayName: unknown): Promise<ActionResult> {
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = challengeIdSchema.safeParse(challengeId);
  const name = z.string().trim().min(1).max(60).safeParse(displayName);
  if (!id.success) return { error: SIGN_IN_FAILED };
  if (!name.success) return { error: 'Enter your name.' };
  const result = await attempt('finishBootstrap', async () => {
    const challenge = await consumeChallenge(id.data, 'bootstrap');
    if (!challenge) return { error: 'The setup took too long or was already used. Start again.' };
    const verified = await verifyNewPasskey(challenge.challenge, response);
    if (!verified) return { error: 'That passkey could not be registered. Start again.' };
    const userId = await bootstrapOwner({
      displayName: name.data,
      passkey: { ...verified, deviceLabel: await currentDeviceLabel() },
    });
    if (!userId) return { error: 'This app is already set up. Sign in with a passkey.' };
    await startSession(userId);
    return { ok: true as const };
  });
  if ('error' in result) return result;
  redirect('/');
}

// ---- More devices, sessions, signing out ----

export async function beginAddDevice(): Promise<Begin<PublicKeyCredentialCreationOptionsJSON>> {
  const user = await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const result = await attempt('beginAddDevice', async () => {
    const rp = relyingParty(process.env);
    const existing = await getUserPasskeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: 'owner',
      userDisplayName: (await getUserDisplayName(user.id)) ?? 'Owner',
      userID: new Uint8Array(Buffer.from(user.id.replace(/-/g, ''), 'hex')),
      attestationType: 'none',
      // A device that already holds one of this user's passkeys is not
      // offered another.
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: (p.transports ?? undefined) as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await createChallenge({ challenge: options.challenge, purpose: 'add_device', userId: user.id });
    return { ok: true as const, options, challengeId };
  });
  return 'error' in result ? result : { options: result.options, challengeId: result.challengeId };
}

export async function finishAddDevice(challengeId: unknown, response: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = challengeIdSchema.safeParse(challengeId);
  if (!id.success) return { error: 'Invalid request.' };
  return attempt('finishAddDevice', async () => {
    const challenge = await consumeChallenge(id.data, 'add_device');
    if (!challenge || challenge.userId !== user.id) return { error: 'Adding the device took too long. Start again.' };
    const verified = await verifyNewPasskey(challenge.challenge, response);
    if (!verified) return { error: 'That passkey could not be registered. Start again.' };
    const label = await currentDeviceLabel();
    await addPasskey(user.id, { ...verified, deviceLabel: label });
    revalidatePath('/devices');
    return { ok: true, message: `Passkey added for ${label}. It can sign in from now on.` };
  });
}

export async function signOut(): Promise<ActionResult> {
  const user = await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const result = await attempt('signOut', async () => {
    await revokeSession(user.id, user.sessionId);
    await clearSessionCookie();
    return { ok: true as const };
  });
  if ('error' in result) return result;
  redirect('/sign-in');
}

export async function revokeOtherSession(sessionId: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.string().uuid().safeParse(sessionId);
  if (!id.success) return { error: 'Invalid session.' };
  if (id.data === user.sessionId) return { error: 'This is the session you are using; sign out instead.' };
  return attempt('revokeOtherSession', async () => {
    if (!(await revokeSession(user.id, id.data))) return { error: 'That session was not found, or is already signed out.' };
    revalidatePath('/devices');
    return { ok: true, message: 'Signed out on that device.' };
  });
}

// A registration answer verified against its challenge, as the fields a
// stored passkey keeps; null when it does not verify.
async function verifyNewPasskey(challenge: string, response: unknown) {
  const rp = relyingParty(process.env);
  try {
    const verified = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!verified.verified) return null;
    const info = verified.registrationInfo;
    return {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
    };
  } catch (err) {
    console.error(`verifyNewPasskey: refused (${err instanceof Error ? err.name : 'error'})`);
    return null;
  }
}
