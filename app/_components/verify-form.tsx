'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { checkAgainstStatement, recordStatementCheck, type VerificationCheck } from '@/app/_actions/ledger';
import { formatUSD, toCents, tryParseDollars } from '@/lib/money';
import { useAction } from './page-result';

// The statement check (REAL-ACCOUNTS.md). Compare as often as needed; only a
// match can be recorded as verified, and the server compares again before it
// records anything.
export function VerifyForm({ accountId, chargesLabel, creditsLabel }: { accountId: string; chargesLabel: string; creditsLabel: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [charges, setCharges] = useState('');
  const [credits, setCredits] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [check, setCheck] = useState<VerificationCheck | null>(null);
  const [comparing, startComparing] = useTransition();
  const { run, pending } = useAction();
  const statement = { from, to, charges, credits, excludedKeys: [...excluded], confirmed };
  const usd = (n: number) => formatUSD(toCents(n));
  // As typed, parsed exactly (never through a float); a dash until it parses.
  const typed = (text: string) => {
    const cents = tryParseDollars(text);
    return cents === null ? '—' : formatUSD(cents);
  };

  const compare = (next = statement) => startComparing(async () => setCheck(await checkAgainstStatement(accountId, next)));
  const toggle = (key: string) => {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExcluded(next);
    compare({ ...statement, excludedKeys: [...next] });
  };
  const result = check && 'ok' in check ? check.result : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="from">Statement from</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="to">to</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="charges">{chargesLabel}</Label>
          <Input id="charges" inputMode="decimal" placeholder="0.00" value={charges} onChange={(e) => setCharges(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="credits">{creditsLabel}</Label>
          <Input id="credits" inputMode="decimal" placeholder="0.00" value={credits} onChange={(e) => setCredits(e.target.value)} />
        </div>
      </div>
      <Button variant="outline" disabled={comparing || !from || !to || !charges || !credits} onClick={() => compare()}>
        {comparing ? 'Comparing…' : 'Compare'}
      </Button>
      {check && 'error' in check && (
        <p role="alert" className="text-sm text-destructive">
          {check.error}
        </p>
      )}
      {result && (
        <div className="space-y-4 text-sm">
          <ul className="space-y-1">
            <li className={result.chargesMatch ? '' : 'text-amber-700 dark:text-amber-400'}>
              {chargesLabel}: bank rows {usd(result.fetchedChargesCents)}, statement {typed(charges)}{' '}
              {result.chargesMatch ? '— match' : '— do not match'}
            </li>
            <li className={result.creditsMatch ? '' : 'text-amber-700 dark:text-amber-400'}>
              {creditsLabel}: bank rows {usd(result.fetchedCreditsCents)}, statement {typed(credits)}{' '}
              {result.creditsMatch ? '— match' : '— do not match'}
            </li>
          </ul>
          <div>
            <p className="mb-1 text-muted-foreground">
              Tick these against the statement: every credit, and the five largest charges. Each must appear with the same
              amount and on the same side. Mark a row that is not on this statement (pending at its close) to leave it out.
            </p>
            <ul className="divide-y rounded-lg border">
              {[...result.toCheck, ...result.excluded].map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span>
                    <span className="font-mono text-xs">{r.postedDate}</span> · {r.description}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className={`font-mono ${r.amountCents < 0 ? 'text-positive' : ''}`}>{usd(r.amountCents)}</span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" checked={excluded.has(r.key)} onChange={() => toggle(r.key)} />
                      not on this statement
                    </label>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); compare({ ...statement, confirmed: e.target.checked }); }} className="mt-1" />
            I checked every row above against the statement: same amounts, credits as credits, charges as charges.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || !result.passed} onClick={() => run(() => recordStatementCheck(accountId, statement, 'pass'))}>
              Record as verified
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => run(() => recordStatementCheck(accountId, statement, 'fail'))}>
              Record as not matching (turns sync off)
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
