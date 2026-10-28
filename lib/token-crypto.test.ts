import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openToken, parseTokenKey, sealToken } from './token-crypto';

const KEY = randomBytes(32);
const TOKEN = 'access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6';
const ITEM = 'eVBnVMp7zdTJLkRNr33Rs6zr7KNJqBFL9DrE6';

describe('parseTokenKey', () => {
  it('accepts the output of `openssl rand -base64 32`', () => {
    const encoded = KEY.toString('base64');
    expect(parseTokenKey(encoded).equals(KEY)).toBe(true);
    expect(parseTokenKey(`  ${encoded}\n`).equals(KEY)).toBe(true);
  });

  it('rejects a missing, malformed, or wrong-length key', () => {
    expect(() => parseTokenKey(undefined)).toThrow(/not set/);
    expect(() => parseTokenKey('')).toThrow(/not set/);
    expect(() => parseTokenKey('not base64!!')).toThrow(/not valid base64/);
    expect(() => parseTokenKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes, got 16/);
  });
});

describe('sealToken / openToken', () => {
  it('round-trips', () => {
    const sealed = sealToken(TOKEN, KEY, ITEM);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(openToken(sealed, KEY, ITEM)).toBe(TOKEN);
  });

  it('uses a fresh IV per seal', () => {
    expect(sealToken(TOKEN, KEY, ITEM)).not.toBe(sealToken(TOKEN, KEY, ITEM));
  });

  it('refuses the wrong key', () => {
    const sealed = sealToken(TOKEN, KEY, ITEM);
    expect(() => openToken(sealed, randomBytes(32), ITEM)).toThrow('Could not open the sealed token');
  });

  it('refuses a token moved onto another item', () => {
    const sealed = sealToken(TOKEN, KEY, ITEM);
    expect(() => openToken(sealed, KEY, 'another-item')).toThrow('Could not open the sealed token');
  });

  it('refuses any tampered part', () => {
    const sealed = sealToken(TOKEN, KEY, ITEM);
    const parts = sealed.split(':');
    for (const index of [1, 2, 3]) {
      const bytes = Buffer.from(parts[index], 'base64url');
      bytes[0] ^= 1;
      const tampered = [...parts];
      tampered[index] = bytes.toString('base64url');
      expect(() => openToken(tampered.join(':'), KEY, ITEM)).toThrow(
        'Could not open the sealed token',
      );
    }
  });

  it('refuses malformed input and unknown versions', () => {
    const sealed = sealToken(TOKEN, KEY, ITEM);
    for (const bad of ['', 'v1:abc', sealed.replace(/^v1/, 'v2'), `${sealed}:extra`, TOKEN]) {
      expect(() => openToken(bad, KEY, ITEM)).toThrow('Could not open the sealed token');
    }
  });
});
