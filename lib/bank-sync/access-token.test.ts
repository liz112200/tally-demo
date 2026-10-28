import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { AccessToken } from './access-token';

const PLAINTEXT = 'access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6';

describe('AccessToken', () => {
  it('reveals the plaintext only through reveal()', () => {
    expect(new AccessToken(PLAINTEXT).reveal()).toBe(PLAINTEXT);
  });

  it('refuses to serialize, directly or nested in a result', () => {
    const token = new AccessToken(PLAINTEXT);
    expect(() => JSON.stringify(token)).toThrow(/never be serialized/);
    // The case types cannot catch: a wider object returned where a narrower
    // type is expected.
    const result = { ok: true, extra: { token } };
    expect(() => JSON.stringify(result)).toThrow(/never be serialized/);
  });

  it('prints a placeholder in strings, templates, and logs', () => {
    const token = new AccessToken(PLAINTEXT);
    expect(String(token)).not.toContain(PLAINTEXT);
    expect(`${token}`).toBe('AccessToken([redacted])');
    expect(inspect(token)).toBe('AccessToken([redacted])');
    expect(inspect({ nested: token })).not.toContain(PLAINTEXT);
    expect(Object.keys(token)).toEqual([]);
  });

  it('rejects an empty token', () => {
    expect(() => new AccessToken('')).toThrow(/Empty/);
  });
});
