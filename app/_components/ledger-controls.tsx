'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { adoptAccount, answerHeldRow, declineReissued, finishBoundaryReview, setUpAccountSync } from '@/app/_actions/ledger';
import type { ActionResult } from '@/lib/action-result';
import { resultMessage } from './action-message';
import { useLoginResult } from './login-result';

// Controls for one account's ledger account, cutover and boundary review on
// /accounts (REAL-ACCOUNTS.md). Results go to the login's result slot.

export type LedgerOption = {
  id: string;
  displayName: string;
  // The last CSV row (undone imports included) and the cutover it implies.
  lastCsvDate: string | null;
  defaultCutover: string | null;
  // The cutover confirmed for it, shown when Change reopens the account's
  // own choice.
  cutoverDate: string | null;
};

function useRun() {
  const report = useLoginResult();
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<ActionResult>, after?: (r: ActionResult) => void) =>
    startTransition(async () => {
      report(null);
      let result: ActionResult;
      try {
        result = await action();
      } catch {
        result = { error: 'Something went wrong. Reload to see what was saved.' };
      }
      report(resultMessage(result));
      after?.(result);
    });
  return { run, pending };
}

// Choose the ledger account an account syncs into. Onto one with CSV
// history, the cutover is shown, editable, and confirmed here; it may not be
// on or before the last CSV row (the server refuses that too).
export function SetUpSyncButton({
  accountId,
  accountLabel,
  options,
  current = null,
}: {
  accountId: string;
  accountLabel: string;
  // What this account may choose (choicesFor): the free ledger accounts and
  // its own.
  options: LedgerOption[];
  // Mapped but not yet synced: the ledger account it is mapped onto. The
  // same dialog, as Change, corrects the choice or its cutover.
  current?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const free = options;
  const withCsv = free.filter((o) => o.lastCsvDate !== null);
  const cutoverOf = (o: LedgerOption | undefined) => (o === undefined ? '' : (o.id === current ? o.cutoverDate : null) ?? o.defaultCutover ?? '');
  const initial = free.find((o) => o.id === current) ?? withCsv[0];
  const [choice, setChoice] = useState<string>(initial?.id ?? 'new');
  const chosen = free.find((o) => o.id === choice) ?? null;
  const [cutover, setCutover] = useState<string>(cutoverOf(initial));
  const [newName, setNewName] = useState(accountLabel);
  const [noCsv, setNoCsv] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { run, pending } = useRun();

  const pick = (id: string) => {
    setChoice(id);
    setProblem(null);
    setCutover(cutoverOf(free.find((o) => o.id === id)));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm">{current ? 'Change…' : 'Set up…'}</Button>} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Where does {accountLabel} sync into?</DialogTitle>
          <DialogDescription>
            If this is an account you already have CSV history for, choose it: the bank then adds only purchases from the
            cutover on, and your CSV rows stay exactly as they are. Nothing syncs until you confirm.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid max-h-[40vh] gap-2 overflow-y-auto text-sm">
          {free.map((o) => (
            <label key={o.id} className="flex items-start gap-2">
              <input type="radio" name="ledger" checked={choice === o.id} onChange={() => pick(o.id)} className="mt-1" />
              <span>
                {o.displayName}
                <span className="block text-xs text-muted-foreground">
                  {o.lastCsvDate ? `CSV history to ${o.lastCsvDate}` : 'No CSV history'}
                </span>
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2">
            <input type="radio" name="ledger" checked={choice === 'new'} onChange={() => pick('new')} className="mt-1" />
            <span>
              A new ledger account
              <span className="block text-xs text-muted-foreground">No CSV history: its full bank history is added.</span>
            </span>
          </label>
        </fieldset>
        {chosen?.lastCsvDate && (
          <div className="grid gap-1">
            <Label htmlFor="cutover">Sync from</Label>
            <Input id="cutover" type="date" value={cutover} min={chosen.defaultCutover ?? undefined} onChange={(e) => setCutover(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              The day after the last CSV row ({chosen.lastCsvDate}). Bank rows before it are never added. A later date leaves
              the days between in neither source; an earlier one would count purchases twice and is refused.
            </p>
          </div>
        )}
        {choice === 'new' && (
          <div className="grid gap-2">
            <div className="grid gap-1">
              <Label htmlFor="ledger-name">Name</Label>
              <Input id="ledger-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            {withCsv.length > 0 && (
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={noCsv} onChange={(e) => setNoCsv(e.target.checked)} className="mt-0.5" />
                This account has no CSV history here (not {withCsv.map((o) => o.displayName).join(', ')}).
              </label>
            )}
          </div>
        )}
        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={pending || (choice === 'new' && (!newName.trim() || (withCsv.length > 0 && !noCsv)))}
            onClick={() =>
              run(
                () =>
                  setUpAccountSync(
                    accountId,
                    choice === 'new'
                      ? { kind: 'new', displayName: newName.trim(), noCsvHistory: noCsv || withCsv.length === 0 }
                      : { kind: 'existing', ledgerAccountId: choice, cutoverDate: chosen?.lastCsvDate ? cutover : null },
                  ),
                (r) => ('error' in r ? setProblem(r.error) : setOpen(false)),
              )
            }
          >
            {pending ? 'Confirming…' : 'Confirm and turn sync on'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReissuedChoice({ accountId, replaces }: { accountId: string; replaces: string }) {
  const { run, pending } = useRun();
  return (
    <div className="mt-1 space-y-1 text-xs">
      <p className="text-amber-700 dark:text-amber-400">
        This looks like {replaces} under a new id. Adopting it continues that account after its last synced row, so nothing is
        counted twice.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => adoptAccount(accountId))}>
          Adopt
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => declineReissued(accountId))}>
          It is a different account
        </Button>
      </div>
    </div>
  );
}

export function HeldRowAnswer({ accountId, providerTransactionId }: { accountId: string; providerTransactionId: string }) {
  const { run, pending } = useRun();
  return (
    <span className="flex gap-1">
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => run(() => answerHeldRow(accountId, providerTransactionId, 'same'))}>
        Same purchase
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => run(() => answerHeldRow(accountId, providerTransactionId, 'released'))}>
        Different: add it
      </Button>
    </span>
  );
}

export function FinishReviewButton({ accountId }: { accountId: string }) {
  const { run, pending } = useRun();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => finishBoundaryReview(accountId))}>
      Done reviewing
    </Button>
  );
}
