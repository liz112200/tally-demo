import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // lib/money.ts lives outside this app's root and is imported directly
    // rather than copied. The money scale has already widened once (cents to
    // mills); a duplicated formatter would have silently kept showing the old
    // scale here, so the shared page reads the same source as the app.
    externalDir: true,
  },
};

export default nextConfig;
