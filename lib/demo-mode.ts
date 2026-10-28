// Whether this deployment is the public demo. Server-side only: the flag is
// read from the environment at request time and passed down to the client
// components that need it.
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === '1';
}

export const DEMO_SOURCE_URL = 'https://github.com/liz112200/tally-demo';
