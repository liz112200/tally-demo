'use client';

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ActionResult } from '@/lib/action-result';
import { useAction } from './page-result';

// The one confirmation pattern for every destructive action (replaces
// window.confirm): title says the action, description says the
// consequence, Cancel stays subtle, the confirm button wears destructive
// styling. onConfirm must return the action's result (ACTION-RESULTS.md):
// on an error the dialog stays open and shows it; on success it closes and
// the page result line says what was done.
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  onConfirm,
  onDone,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  onConfirm: () => Promise<ActionResult>;
  // After a success, once the dialog has closed.
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useAction({ errorsInPlace: true });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              // The dialog closes on success only, not on click.
              e.preventDefault();
              setError(null);
              run(onConfirm, (result) => {
                if ('error' in result) {
                  setError(result.error);
                } else {
                  setOpen(false);
                  onDone?.();
                }
              });
            }}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
