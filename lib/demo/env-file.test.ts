import { describe, expect, it } from 'vitest';
import { demoEnvFile } from './env-file';

describe('demoEnvFile', () => {
  it('reads the demo file by default and the local one only when asked', () => {
    expect(demoEnvFile({})).toBe('.env.demo');
    expect(demoEnvFile({ DEMO_ENV: 'local' })).toBe('.env.demo-local');
  });
  it('refuses any other file, the owner\'s real credentials included', () => {
    expect(() => demoEnvFile({ DEMO_ENV: '.env.local' })).toThrow('DEMO_ENV must be "demo" or "local"');
    expect(() => demoEnvFile({ DEMO_ENV: 'production' })).toThrow();
  });
});
