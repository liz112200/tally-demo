'use client';

import { useSyncExternalStore } from 'react';
import { isOrientationDismissed, subscribeOrientation } from '@/lib/demo/orientation';

// Whether this browser dismissed the demo's first-visit strip. The server
// read the same answer from the request's cookie (app/layout.tsx), so the
// first render already has it and nothing appears or vanishes after load.
export function useOrientationDismissed(fromServer: boolean): boolean {
  return useSyncExternalStore<boolean>(subscribeOrientation, () => isOrientationDismissed(), () => fromServer);
}
