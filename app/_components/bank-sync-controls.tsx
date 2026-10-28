'use client';

import { useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setAccountSync, syncConnection } from '@/app/_actions/bank';
import { useLoginResult } from './login-result';

// "Sync now" for one connection. The result goes to the login's result slot
// (login-result.tsx): a line per account, or one line when the login cannot
// sync; the page re-renders with the new rows through revalidatePath.
export function SyncNowButton({ connectionId, disabled }: { connectionId: string; disabled: boolean }) {
  const report = useLoginResult();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      title={disabled ? 'Choose at least one account to sync' : undefined}
      onClick={() =>
        startTransition(async () => {
          report(null);
          const result = await syncConnection(connectionId);
          if ('error' in result) report({ kind: 'error', text: result.error });
          else if (result.complete) report({ kind: 'success', text: 'Synced.', details: result.lines });
          else if (result.lines.length === 1) report({ kind: 'warning', text: result.lines[0] });
          else report({ kind: 'warning', text: 'Not every account synced.', details: result.lines });
        })
      }
    >
      <RefreshCw data-icon="inline-start" className={pending ? 'animate-spin' : undefined} />
      {pending ? 'Syncing…' : 'Sync now'}
    </Button>
  );
}

// Opt-in for one account. Off by default: nothing syncs until chosen.
export function AccountSyncToggle({
  accountId,
  enabled,
  label,
}: {
  accountId: string;
  enabled: boolean;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex flex-col items-end gap-0.5">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={enabled}
          disabled={pending}
          aria-label={`Sync ${label}`}
          onChange={(e) => {
            const next = e.target.checked;
            startTransition(async () => {
              setError(null);
              const result = await setAccountSync(accountId, next);
              if ('error' in result) setError(result.error);
            });
          }}
        />
        Sync
      </label>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
