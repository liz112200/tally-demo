import { describe, expect, it } from 'vitest';
import { hashSessionToken, isBootstrapToken, isCronRequest, isPublicPath, newSessionToken, sessionCookie } from './session-token';
import { relyingParty } from './relying-party';

describe('session tokens', () => {
  it('are 256 random bits, and only their hash is stored', () => {
    const a = newSessionToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newSessionToken()).not.toBe(a);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).not.toContain(a);
  });

  it('live in a host-only, HttpOnly cookie, Secure outside localhost', () => {
    expect(sessionCookie(true)).toMatchObject({
      name: '__Host-tally_session',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    });
    expect(sessionCookie(false).name).toBe('tally_session');
  });
});

describe('public paths', () => {
  it('are sign-in, share snapshots, the cron route and the demo routes; nothing else', () => {
    for (const p of ['/sign-in', '/s/abc123', '/api/cron/sync', '/api/demo/reset']) expect(isPublicPath(p)).toBe(true);
    for (const p of ['/', '/people', '/rules', '/insights', '/accounts', '/accounts/oauth', '/sign-in/x', '/s', '/api/other', '/signin'])
      expect(isPublicPath(p)).toBe(false);
  });
});

describe('the cron secret', () => {
  const secret = 'a-long-cron-secret-value';
  it('accepts exactly the bearer header Vercel Cron sends', () => {
    expect(isCronRequest(`Bearer ${secret}`, secret)).toBe(true);
    expect(isCronRequest(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isCronRequest(secret, secret)).toBe(false);
    expect(isCronRequest(null, secret)).toBe(false);
  });

  it('refuses everything when the secret is unset or short', () => {
    expect(isCronRequest('Bearer ', '')).toBe(false);
    expect(isCronRequest('Bearer undefined', undefined)).toBe(false);
    expect(isCronRequest('Bearer short', 'short')).toBe(false);
  });
});

describe('the bootstrap token', () => {
  it('matches only itself, and nothing when unset or short', () => {
    expect(isBootstrapToken('a-long-bootstrap-token', 'a-long-bootstrap-token')).toBe(true);
    expect(isBootstrapToken('a-long-bootstrap-tokeN', 'a-long-bootstrap-token')).toBe(false);
    expect(isBootstrapToken('', undefined)).toBe(false);
    expect(isBootstrapToken('abc', 'abc')).toBe(false);
  });
});

describe('relyingParty', () => {
  it("is the project's stable production hostname in production", () => {
    expect(relyingParty({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'tally-owner.vercel.app' })).toEqual({
      rpID: 'tally-owner.vercel.app',
      origin: 'https://tally-owner.vercel.app',
      rpName: 'Tally',
    });
    expect(() => relyingParty({ VERCEL_ENV: 'production' })).toThrow(/stable hostname/);
  });

  it('refuses previews, whose hostname changes per deployment, and is localhost in dev', () => {
    expect(() => relyingParty({ VERCEL_ENV: 'preview' })).toThrow(/preview/);
    expect(relyingParty({})).toEqual({ rpID: 'localhost', origin: 'http://localhost:3000', rpName: 'Tally' });
    expect(relyingParty({ AUTH_ORIGIN: 'http://localhost:3100' }).origin).toBe('http://localhost:3100');
  });
});
