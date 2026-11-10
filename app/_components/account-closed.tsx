'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { setAccountClosed } from '@/app/_actions/reviews';
import { useAction } from './page-result';

// An account that closed (migration 0037): its own fact, recorded once,
// ending what statements are expected of it, rather than each missing
// statement reviewed away in turn. Clearing it is for a date recorded by
// mistake.
export function AccountClosed({ ledgerAccountId, closedOn, today }: { ledgerAccountId: string; closedOn: string | null; today: string }) {
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  if (closedOn) {
    return (
      <p className="flex flex-wrap items-center gap-2 pt-2 text-muted-foreground">
        Closed on {closedOn}.
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={pending} onClick={() => run(() => setAccountClosed(ledgerAccountId, null))}>
          It is not closed
        </Button>
      </p>
    );
  }
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        This account has closed
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2 pt-2">
      <label className="grid gap-1">
        <span className="text-muted-foreground">The day it closed. No statement is expected after it.</span>
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs" />
      </label>
      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pending || !date} onClick={() => run(() => setAccountClosed(ledgerAccountId, date), (r) => !('error' in r) && setOpen(false))}>
        Mark closed
      </Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}
