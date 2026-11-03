import { describe, expect, it } from 'vitest';
import type { BankProvider } from './provider';
import { chooseProvider, openStoredToken } from './select-provider';
import { syntheticToken } from './synthetic/provider';

const fake = (name: 'plaid' | 'synthetic') => ({ name }) as BankProvider;

describe('chooseProvider', () => {
  it('production never builds the synthetic provider', () => {
    const made: string[] = [];
    const p = chooseProvider(false, {
      plaid: () => (made.push('plaid'), fake('plaid')),
      synthetic: () => (made.push('synthetic'), fake('synthetic')),
    });
    expect(p.name).toBe('plaid');
    expect(made).toEqual(['plaid']);
  });

  it('the demo never builds Plaid', () => {
    const made: string[] = [];
    const p = chooseProvider(true, {
      plaid: () => (made.push('plaid'), fake('plaid')),
      synthetic: () => (made.push('synthetic'), fake('synthetic')),
    });
    expect(p.name).toBe('synthetic');
    expect(made).toEqual(['synthetic']);
  });
});

describe('openStoredToken', () => {
  const synthetic = { provider: 'synthetic' as const, providerItemId: 'demo-item-a', accessTokenSealed: syntheticToken('demo-item-a') };
  const plaid = { provider: 'plaid' as const, providerItemId: 'item-1', accessTokenSealed: 'sealed' };
  const unseal = () => 'access-sandbox-0000';

  it('opens a synthetic connection only in the demo, and never unseals for it', () => {
    let unsealed = 0;
    expect(openStoredToken(true, synthetic, () => (unsealed++, 'x')).reveal()).toBe('synthetic:demo-item-a');
    expect(unsealed).toBe(0);
    expect(() => openStoredToken(false, synthetic, unseal)).toThrow('opens only in the demo');
  });

  it('opens a Plaid connection only outside the demo', () => {
    expect(openStoredToken(false, plaid, unseal).reveal()).toBe('access-sandbox-0000');
    expect(() => openStoredToken(true, plaid, unseal)).toThrow('The demo opens no Plaid connection');
  });

  it('refuses a synthetic row carrying anything but its own token', () => {
    expect(() => openStoredToken(true, { ...synthetic, accessTokenSealed: syntheticToken('demo-item-b') }, unseal)).toThrow();
    expect(() => openStoredToken(true, { ...synthetic, accessTokenSealed: 'sealed-plaid-value' }, unseal)).toThrow();
  });
});
