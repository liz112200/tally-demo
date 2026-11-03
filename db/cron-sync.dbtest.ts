import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const run = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/app/_lib/scheduled-sync', () => ({
  runScheduledSync: async () => {
    run.calls += 1;
    return [];
  },
}));

import { GET } from '@/app/api/cron/sync/route';

// The daily sync's route (SCHEDULED-SYNC.md): nothing runs without the
// cron secret, and nothing runs on the demo.
const SECRET = 'a-test-cron-secret-of-some-length';
const call = (authorization?: string) =>
  GET(new Request('http://localhost/api/cron/sync', { headers: authorization ? { authorization } : {} }));

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.DEMO_MODE;
  run.calls = 0;
});

describe('the daily sync route', () => {
  it('refuses without the secret, with a wrong one, and when none is configured, running nothing', async () => {
    expect((await call()).status).toBe(401);
    process.env.CRON_SECRET = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).status).toBe(401);
    expect((await call(SECRET)).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect(run.calls).toBe(0);
  });

  it('is a 404 on the demo, even with the secret', async () => {
    process.env.CRON_SECRET = SECRET;
    process.env.DEMO_MODE = '1';
    expect((await call(`Bearer ${SECRET}`)).status).toBe(404);
    expect(run.calls).toBe(0);
  });

  it('runs the daily sync with the secret', async () => {
    process.env.CRON_SECRET = SECRET;
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logins: [] });
    expect(run.calls).toBe(1);
  });
});
