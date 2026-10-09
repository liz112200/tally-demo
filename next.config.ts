import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { assertSafeEnvironment } from './lib/deploy-guard';
import { demoStoreProblems } from './db/demo-guard';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Receipt uploads go through a Server Action; the default 1 MB body
      // limit rejects any phone photo. 12 MB covers the app's 10 MB
      // receipt cap plus multipart overhead.
      bodySizeLimit: '12mb',
    },
  },
  async redirects() {
    return [
      // Balances merged into People in phase 6; keep old links working.
      { source: '/balances', destination: '/people', permanent: false },
    ];
  },
};

// The demo deployment guard runs before anything else: a demo deployment on
// production credentials fails here, at build, instead of serving. The store
// markers need the network, so they are checked once per build, where the
// environment is fixed for the life of the deployment.
export default async function config(phase: string): Promise<NextConfig> {
  assertSafeEnvironment(process.env, 'build');
  if (phase === PHASE_PRODUCTION_BUILD && process.env.DEMO_MODE === '1') {
    const problems = await demoStoreProblems({
      DATABASE_URL: process.env.DATABASE_URL,
      BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (problems.length > 0) {
      throw new Error(
        `Refusing to build the demo: its stores are not the demo's.\n- ${problems.join('\n- ')}`,
      );
    }
  }
  return nextConfig;
}
