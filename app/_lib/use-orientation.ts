'use client';

import { useSyncExternalStore } from 'react';
import { isOrientationDismissed, subscribeOrientation } from '@/lib/demo/orientation';

// Whether this browser dismissed the demo's first-visit strip; null until
// mounted, so the server render never shows a strip the visitor closed.
export function useOrientationDismissed(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribeOrientation, () => isOrientationDismissed(), () => null);
}
