// Encryption at rest for bank access tokens (BANK-SYNC.md). A Plaid access
// token plus the client secret is full read access to an account, so the
// database only ever holds it sealed: a leaked backup, branch, or misconfigured
// deployment yields ciphertext without the key, which lives only in the
// environment (BANK_TOKEN_KEY).
//
// AES-256-GCM with a random 96-bit IV per seal. The caller's associated data
// (the Plaid item_id) is authenticated but not stored in the blob, so a sealed
// token copied onto another connection's row fails to open there.
//
// Sealed form, FROZEN per version: `v1:<iv>:<tag>:<ciphertext>`, each part
// base64url. The version prefix is what lets a future key rotation tell old
// blobs from new ones.
//
// Pure: no Next, database, or environment access; the key is passed in.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Decode BANK_TOKEN_KEY (standard base64 of 32 random bytes, as printed by
// `openssl rand -base64 32`). Strict: Buffer.from() silently skips characters
// that are not base64, so the decoded bytes must re-encode to the input.
export function parseTokenKey(base64: string | undefined): Buffer {
  const trimmed = base64?.trim() ?? '';
  if (trimmed === '') throw new Error('BANK_TOKEN_KEY is not set');
  const key = Buffer.from(trimmed, 'base64');
  if (key.toString('base64') !== trimmed) {
    throw new Error('BANK_TOKEN_KEY is not valid base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`BANK_TOKEN_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export function sealToken(plaintext: string, key: Buffer, associatedData: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  ).join(':');
}

// Every failure — wrong key, wrong associated data, tampering, malformed
// input — surfaces as the same error, so nothing about why leaks to a caller.
export function openToken(sealed: string, key: Buffer, associatedData: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Could not open the sealed token');
  }
  const [, ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Could not open the sealed token');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not open the sealed token');
  }
}
