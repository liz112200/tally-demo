'use client';

import { useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { applyPatch, type ParamPatch } from '@/lib/table-state';

// Table view state (sort, filters) lives in the URL search params. Writes
// go through history.replaceState rather than router.push/replace: this is
// pure view state, so it should not create history entries or re-run the
// server component — the tables filter and sort client-side over data the
// page already loaded. useSearchParams stays in sync with history API
// updates in the App Router.
export function useTableState() {
  const pathname = usePathname();
  const params = useSearchParams();

  const apply = useCallback(
    (patch: ParamPatch) => {
      // Read the live location, not the params snapshot: two patches in one
      // tick (e.g. changing a filter also resets paging state) must compose.
      const next = applyPatch(
        new URLSearchParams(window.location.search),
        patch,
      );
      const qs = next.toString();
      window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname],
  );

  return { params, apply };
}
