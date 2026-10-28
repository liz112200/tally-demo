// What a bank login's error means to the owner, and the one repair the app
// offers for it (BANK-SYNC.md, slice 4). Pure.
//
// The codes are Plaid's (the synthetic demo provider speaks the same
// vocabulary). Plaid's own guidance for several of them is to "link the
// account again", which on the Trial plan spends an Item for good. The app
// never offers that: every repair is Link's update mode on the existing Item
// (Reconnect), which creates nothing. Where update mode cannot help, the app
// says so and offers nothing; linking again stays a decision the owner makes
// on purpose, with the budget in front of them.

export type ItemHealthKind =
  // No error.
  | 'healthy'
  // The login needs the owner: signing in again, renewing consent.
  | 'reconnect'
  // Something must be done at the bank first, then Reconnect.
  | 'fix_at_bank'
  // The institution is down or not answering; the next sync tries again.
  | 'bank_unavailable'
  // Plaid no longer recognises the login; the stored token opens nothing.
  | 'gone'
  // A code this table does not know: shown as is, Reconnect offered.
  | 'unknown';

const RECONNECT = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_CREDENTIALS',
  'INVALID_UPDATED_USERNAME',
]);

const FIX_AT_BANK = new Set(['ITEM_LOCKED', 'USER_SETUP_REQUIRED', 'PASSWORD_RESET_REQUIRED']);

const BANK_UNAVAILABLE = new Set([
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
]);

const GONE = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']);

export function classifyItemError(code: string | null): ItemHealthKind {
  if (code === null) return 'healthy';
  if (RECONNECT.has(code)) return 'reconnect';
  if (FIX_AT_BANK.has(code)) return 'fix_at_bank';
  if (BANK_UNAVAILABLE.has(code)) return 'bank_unavailable';
  if (GONE.has(code)) return 'gone';
  return 'unknown';
}

// Whether a code means the login itself no longer exists at the provider.
// Removal treats it as "already removed" (db side of a removal that failed
// after Plaid's half succeeded).
export function isGone(code: string | null): boolean {
  return classifyItemError(code) === 'gone';
}

// Reconnect never creates an Item, so it is offered for every state but
// `gone`, where there is no Item left to update. A healthy login can still
// reconnect: to renew consent, or to change which accounts it shares.
export function offersReconnect(kind: ItemHealthKind): boolean {
  return kind !== 'gone';
}

// Days before a consent expiry that the owner is warned.
export const CONSENT_WARNING_DAYS = 7;

export type ConsentState = 'none' | 'ok' | 'soon' | 'expired';

export function consentState(expiresAt: Date | null, now: Date): ConsentState {
  if (expiresAt === null) return 'none';
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  return left <= CONSENT_WARNING_DAYS * 24 * 60 * 60 * 1000 ? 'soon' : 'ok';
}

// The badge for a login's health; null when healthy.
export function healthLabel(code: string | null): string | null {
  switch (classifyItemError(code)) {
    case 'healthy':
      return null;
    case 'reconnect':
      return 'Needs reconnecting';
    case 'fix_at_bank':
      return 'Needs attention at the bank';
    case 'bank_unavailable':
      return 'Bank unavailable';
    case 'gone':
      return 'No longer at Plaid';
    case 'unknown':
      return code;
  }
}

// Why nothing synced, as a clause for a sync result. The full sentence, with
// what to do, is shown once on the login, not repeated per account.
export function healthClause(code: string | null): string | null {
  switch (classifyItemError(code)) {
    case 'healthy':
      return null;
    case 'reconnect':
      return 'the login needs reconnecting';
    case 'fix_at_bank':
      return 'the login needs attention at the bank';
    case 'bank_unavailable':
      return 'the bank is not answering through Plaid';
    case 'gone':
      return 'Plaid no longer recognises this login';
    case 'unknown':
      return `Plaid reports ${code}`;
  }
}

// One sentence for the owner, naming the institution and what to do. Null
// when there is nothing to say.
export function healthSentence(code: string | null, institution: string): string | null {
  const kind = classifyItemError(code);
  switch (kind) {
    case 'healthy':
      return null;
    case 'reconnect':
      return `${institution} needs you to sign in again. Reconnect opens its sign-in for this same login; no new Item is used.`;
    case 'fix_at_bank':
      return code === 'ITEM_LOCKED'
        ? `The login is locked at ${institution}. Unlock it there, then Reconnect.`
        : code === 'PASSWORD_RESET_REQUIRED'
          ? `${institution} requires a new password. Reset it there, then Reconnect with the new one.`
          : `${institution} wants something done in its own site or app first, such as accepting new terms. Do that, then Reconnect.`;
    case 'bank_unavailable':
      return `${institution} is not answering through Plaid right now. Nothing to do; the next sync tries again.`;
    case 'gone':
      return (
        `Plaid no longer recognises this login (${code}), so Reconnect cannot repair it. Its rows stay. ` +
        `To sync ${institution} again, remove this login (that uses nothing at Plaid), then link ${institution}, which uses a new Item.`
      );
    case 'unknown':
      return `Plaid reports ${code} for this login. Reconnect is the repair to try; it uses no new Item.`;
  }
}
