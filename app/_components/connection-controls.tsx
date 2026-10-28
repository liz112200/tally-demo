'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { Activity, Pause, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { checkConnection, removeLogin, setLoginPaused } from '@/app/_actions/bank';
import { ReconnectButton } from './link-bank-button';
import { resultMessage } from './action-message';
import { useLoginResult } from './login-result';

// One way to act on a login, with the sentence saying what it does to it,
// as in the bank flag panel.
function Option({ action, children }: { action: ReactNode; children: ReactNode }) {
  return (
    <li className="grid gap-1 sm:grid-cols-[13rem_1fr] sm:items-baseline sm:gap-3">
      <div>{action}</div>
      <p className="text-muted-foreground">{children}</p>
    </li>
  );
}

function ActionButton({
  icon,
  label,
  pendingLabel,
  run,
}: {
  icon: ReactNode;
  label: string;
  pendingLabel: string;
  run: () => Promise<{ error: string } | { ok: true; message?: string; warning?: string }>;
}) {
  const report = useLoginResult();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          report(null);
          report(resultMessage(await run()));
        })
      }
    >
      {icon}
      {pending ? pendingLabel : label}
    </Button>
  );
}

export type LoginSentences = {
  reconnect: string;
  chooseAccounts: string;
  check: string;
  pauseOrResume: string;
  remove: string;
};

// Everything that can be done to one login. Every repair is update mode on
// this same Item; nothing here links a login again.
export function ManageLogin({
  connectionId,
  institution,
  status,
  reconnectable,
  needsOwner,
  sentences,
}: {
  connectionId: string;
  institution: string;
  status: 'active' | 'paused';
  // False only for a login Plaid no longer recognises (item-health.ts).
  reconnectable: boolean;
  // The login needs the owner: Reconnect is the primary action.
  needsOwner: boolean;
  sentences: LoginSentences;
}) {
  return (
    <ul className="space-y-2 px-4 py-3 text-sm">
      {reconnectable && (
        <Option action={<ReconnectButton connectionId={connectionId} primary={needsOwner} />}>{sentences.reconnect}</Option>
      )}
      {reconnectable && (
        <Option action={<ReconnectButton connectionId={connectionId} accountSelection />}>{sentences.chooseAccounts}</Option>
      )}
      <Option
        action={
          <ActionButton icon={<Activity data-icon="inline-start" />} label="Check" pendingLabel="Checking…" run={() => checkConnection(connectionId)} />
        }
      >
        {sentences.check}
      </Option>
      <Option
        action={
          status === 'active' ? (
            <ActionButton
              icon={<Pause data-icon="inline-start" />}
              label="Pause"
              pendingLabel="Pausing…"
              run={() => setLoginPaused(connectionId, true)}
            />
          ) : (
            <ActionButton
              icon={<Play data-icon="inline-start" />}
              label="Resume"
              pendingLabel="Resuming…"
              run={() => setLoginPaused(connectionId, false)}
            />
          )
        }
      >
        {sentences.pauseOrResume}
      </Option>
      <Option action={<RemoveLoginDialog connectionId={connectionId} institution={institution} needsOwner={needsOwner} sentence={sentences.remove} />}>
        {sentences.remove}
      </Option>
    </ul>
  );
}

// Removal asks for the institution's name to be typed; the server compares
// it too, so nothing is removed by a stray click or a forged request.
function RemoveLoginDialog({
  connectionId,
  institution,
  needsOwner,
  sentence,
}: {
  connectionId: string;
  institution: string;
  needsOwner: boolean;
  sentence: string;
}) {
  const report = useLoginResult();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = typed.trim().toLowerCase() === institution.trim().toLowerCase();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped('');
          setError(null);
        }
      }}
    >
      <AlertDialogTrigger
        render={
          <Button variant="ghost" size="sm" className="text-destructive">
            <Trash2 data-icon="inline-start" />
            Remove…
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {institution}?</AlertDialogTitle>
          <AlertDialogDescription>
            {needsOwner && (
              <span className="mb-2 block font-medium text-foreground">
                This login needs reconnecting. Removing it does not fix that; Reconnect does, with no new Item.
              </span>
            )}
            {sentence}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">
            Type <span className="font-medium text-foreground">{institution}</span> to confirm.
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Institution name" />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!matches || pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await removeLogin(connectionId, typed);
                if ('error' in result) setError(result.error);
                else {
                  setOpen(false);
                  report(resultMessage(result));
                }
              })
            }
          >
            {pending ? 'Removing…' : 'Remove for good'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
