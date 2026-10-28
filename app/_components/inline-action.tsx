'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/lib/action-result';
import { useAction } from './page-result';

// A destructive action inside a dialog that is already open (Remove split,
// Remove receipt). On success the page result line says what happened and
// `onSuccess` runs (typically closing the dialog); an error stays here,
// beside the button.
export function InlineAction({
  icon,
  label,
  pendingLabel,
  action,
  onSuccess,
}: {
  icon: ReactNode;
  label: string;
  pendingLabel: string;
  action: () => Promise<ActionResult>;
  onSuccess: () => void;
}) {
  const { run, pending } = useAction({ errorsInPlace: true });
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => {
          setError(null);
          run(action, (result) => ('error' in result ? setError(result.error) : onSuccess()));
        }}
      >
        {icon}
        {pending ? pendingLabel : label}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
