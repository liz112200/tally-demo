import { NextResponse } from 'next/server';

// The share site has no sign-in: every snapshot is public at its token. This
// file exists so the build does not take the app's proxy.ts from the
// repository root instead, which it did from slice 6: that proxy redirects
// signed-out requests to /sign-in, which this site does not have, and its
// imports do not resolve here, so every share deployment failed to build
// (2026-10-27 to 10-28) and the last good one kept serving.
export function proxy() {
  return NextResponse.next();
}
