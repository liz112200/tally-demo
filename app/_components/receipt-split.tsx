'use client';

import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, ReceiptText } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import type { ReceiptView } from '@/db/queries';
import { formatUSD, toCents } from '@/lib/money';
import { explainItemShares } from '@/lib/split';
import { saveItemSplit } from '@/app/_actions/splits';
import type { ItemSplitState } from '@/app/_lib/schema';
import type { PersonOption } from './split-editor';
import { useIsDemo } from '@/app/_lib/use-demo';
import { ItemAssignees, assignmentLabel } from './item-assignees';
import { useReportSuccess } from './page-result';

const money = (value: number) => formatUSD(toCents(value));
const initial: ItemSplitState = {};

export function ReceiptSplit({ receipt, persons, amountCents, sample = false, embedded = false, onBack, onSaved }: {
  receipt: ReceiptView;
  persons: PersonOption[];
  amountCents: number;
  sample?: boolean;
  embedded?: boolean;
  onBack?: () => void;
  onSaved?: () => void;
}) {
  const demo = useIsDemo();
  const [beforeBulk, setBeforeBulk] = useState<Map<string, string[]> | null>(null);
  const owner = persons.find((p) => p.isOwner);
  const [assignments, setAssignments] = useState(() => new Map(receipt.items.map((item) =>
    [item.id, item.assignedPersonIds.length ? item.assignedPersonIds : owner ? [owner.id] : []],
  )));
  const [editing, setEditing] = useState<string | undefined>(
    (receipt.items.find((i) => i.assignedPersonIds.length > 1) ?? receipt.items[0])?.id,
  );
  const [state, dispatch, pending] = useActionState(saveItemSplit, initial);
  // The wizard closes on success and reports to its parent page. The standalone
  // editor stays here with a persistent confirmation and navigation.
  useReportSuccess(onSaved ? state : initial, demo ? '/people' : undefined);
  const savedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!state.ok) return;
    if (onSaved) onSaved();
    else savedHeading.current?.focus();
  }, [state, onSaved]);

  const names = new Map(persons.map((p) => [p.id, p.isOwner ? 'You' : p.name]));
  const name = (id: string) => names.get(id) ?? 'Inactive person';
  const originalGuests = persons.filter((p) => !p.isOwner && receipt.items.some((item) => item.assignedPersonIds.includes(p.id)));
  const partner = originalGuests.length === 1 ? originalGuests[0] : !originalGuests.length && persons.length === 2 ? persons.find((p) => !p.isOwner) : undefined;
  const itemTotal = receipt.items.reduce((sum, item) => sum + item.amountCents, receipt.taxCents + receipt.tipCents);

  let shares: ReturnType<typeof explainItemShares> = [];
  let problem: string | undefined;
  try {
    if (!owner) throw new Error('Owner person missing');
    if (demo && receipt.items.some((item) => !assignments.get(item.id)?.length)) {
      throw new Error('Choose at least one person for each item.');
    }
    if ([...assignments.values()].some((ids) => ids.some((id) => !names.has(id)))) {
      throw new Error('An item includes an inactive person. Reassign that item before saving.');
    }
    shares = explainItemShares({
      ownerId: owner.id, taxCents: toCents(receipt.taxCents), tipCents: toCents(receipt.tipCents),
      personOrder: persons.map((p) => p.id),
      items: receipt.items.map((i) => ({ amountCents: toCents(i.amountCents), assigneePersonIds: assignments.get(i.id) ?? [] })),
    });
  } catch (error) {
    problem = error instanceof Error ? error.message : 'Check item assignments.';
  }
  const otherDiners = new Set([...assignments].filter(([id]) => id !== editing).flatMap(([, ids]) => ids));
  const mealGroup = persons.filter((p) => otherDiners.has(p.id)).map((p) => p.id);
  const guests = shares.filter((s) => s.personId !== owner?.id);
  const sharedTotal = guests.reduce((sum, s) => sum + s.amountCents, 0);
  function assign(itemId: string, ids: string[]) {
    setBeforeBulk(null);
    setAssignments((prev) => new Map(prev).set(itemId, demo || ids.length ? ids : owner ? [owner.id] : []));
  }
  function save() {
    const data = new FormData();
    data.set('payload', JSON.stringify({
      receiptId: receipt.id, transactionId: receipt.transactionId,
      assignments: receipt.items.map((item) => ({ itemId: item.id, personIds: assignments.get(item.id) ?? [] })),
    }));
    startTransition(() => dispatch(data));
  }

  if (state.ok && !onSaved) {
    const balancesHref = guests.length === 1 ? `/people?person=${guests[0].personId}` : '/people';
    return (
      <section className="max-w-2xl space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 ref={savedHeading} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Check className="size-5 text-primary" aria-hidden />Split saved
        </h2>
        <p className="break-words text-sm">{receipt.merchant || 'Receipt'} · <span className="font-mono">{money(itemTotal)}</span></p>
        <div className="flex flex-wrap gap-2">
          <Link className={buttonVariants()} href={balancesHref}>View balances</Link>
          {sample && <>
            <Link className={buttonVariants({ variant: 'outline' })} href="/accounts/logins">Try bank sync</Link>
            <Link className={buttonVariants({ variant: 'ghost' })} href={`/expenses?tx=${receipt.transactionId}`}>View expense</Link>
          </>}
        </div>
      </section>
    );
  }

  const pill = 'min-h-9 rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary pointer-coarse:min-h-11';
  return (
    <div data-guest-receipt={demo ? true : undefined} className={embedded ? "ledger-receipt" : "grid items-start gap-4 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"}>
      <section aria-label="Itemized receipt" className={embedded ? "min-w-0" : "min-w-0 rounded-xl border bg-card p-4 sm:p-5"}>
        {embedded ? <h3 className="text-sm font-semibold">Receipt items</h3> : <>
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ReceiptText className="size-4 text-primary" aria-hidden />
          {receipt.date && <><time dateTime={receipt.date}>{receipt.date}</time><span>·</span></>}
          You paid
        </div>
        <h2 className="mt-2 break-words text-xl font-semibold tracking-tight">{receipt.merchant || 'Itemized receipt'}</h2></>}
        <ul className="mt-4 divide-y border-y">
          {receipt.items.map((item, index) => {
            const ids = assignments.get(item.id) ?? [];
            const selected = editing === item.id;
            const quickPair = owner && partner;
            const picker = (
              <div role="group" aria-label={'People sharing ' + item.description} className="flex flex-wrap gap-1.5 py-2">
                {persons.map((p) => (
                  <button className={pill} type="button" key={p.id} disabled={pending} aria-pressed={ids.includes(p.id)}
                    onClick={() => assign(item.id, ids.includes(p.id) ? ids.filter((id) => id !== p.id && names.has(id)) : [...ids.filter((id) => names.has(id)), p.id])}>
                    {name(p.id)}
                  </button>
                ))}
                <button type="button" className="px-2 text-xs underline" disabled={pending}
                  onClick={() => assign(item.id, persons.map((p) => p.id))}>Everyone</button>
              </div>
            );
            return (
              <li key={item.id}>
                <button type="button" className="flex w-full items-center gap-3 py-3 text-left" aria-expanded={selected}
                  onClick={() => setEditing(selected ? undefined : item.id)}>
                  <span className="min-w-0 flex-1 break-words font-medium">{item.quantity !== 1 && <span>{item.quantity} × </span>}{item.description}
                    <span className="block text-xs font-normal text-muted-foreground">{demo ? assignmentLabel(ids, persons) : ids.map(name).join(' · ') || 'You'}</span>
                  </span>
                  <span className="font-mono text-sm">{money(item.amountCents)}</span>
                  <ChevronDown className={'size-4 text-muted-foreground ' + (selected ? 'rotate-180' : '')} aria-hidden />
                </button>
                {selected && <div className="space-y-2 pb-3">
                  {demo ? <ItemAssignees mealGroup={mealGroup} persons={persons} ids={ids} item={item.description} pending={pending}
                    previous={index > 0 ? { description: receipt.items[index - 1].description, ids: assignments.get(receipt.items[index - 1].id) ?? [] } : undefined}
                    onChange={(next) => assign(item.id, next)} /> : quickPair ? <>
                    <div role="group" aria-label={'Assign ' + item.description} className="flex flex-wrap gap-1">
                      {[{ label: 'You', group: [owner.id] }, { label: 'Both', group: [owner.id, partner.id] },
                        { label: partner.name, group: [partner.id] }].map(({ label, group }) => {
                        return <button type="button" className={pill} key={group.join(',')} disabled={pending}
                          aria-pressed={ids.length === group.length && group.every((id) => ids.includes(id))}
                          onClick={() => assign(item.id, group)}>{label}</button>;
                      })}
                    </div>
                    {persons.length > 2 && <details><summary className="cursor-pointer py-1 text-xs text-muted-foreground">More people</summary>{picker}</details>}
                  </> : picker}
                  <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" disabled={pending}
                    onClick={() => {
                      if (demo) setBeforeBulk((previous) => previous ?? assignments);
                      setAssignments(new Map(receipt.items.map((i) => [i.id, [...ids]])));
                    }}>Apply to all items</button>
                  {demo && beforeBulk && <button type="button" className="ml-3 text-xs font-medium text-primary underline" disabled={pending}
                    onClick={() => { setAssignments(beforeBulk); setBeforeBulk(null); }}>Undo</button>}
                </div>}
              </li>
            );
          })}
        </ul>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-3"><dt>Tax</dt><dd>{money(receipt.taxCents)}</dd></div>
          <div className="flex justify-between gap-3"><dt>Tip</dt><dd>{money(receipt.tipCents)}</dd></div>
          <div className="flex justify-between gap-3 border-t pt-3 font-semibold"><dt>Receipt total</dt><dd>{money(receipt.totalCents)}</dd></div>
        </dl>
        {amountCents !== receipt.totalCents && <p className="mt-2 text-xs">Transaction amount {money(amountCents)}{receipt.mismatchNote && ' · ' + receipt.mismatchNote}</p>}
        {itemTotal !== receipt.totalCents && <p className="mt-2 text-xs text-warning">Items, tax and tip add up to {money(itemTotal)}. The split uses that amount.</p>}
      </section>
      <section aria-label="Split preview" className={embedded ? "min-w-0" : "min-w-0 rounded-xl border bg-card p-4 sm:p-5"}>
        <h2 className="mb-3 text-base font-semibold">Split preview</h2>
        {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : <>
          <div aria-live="polite" aria-atomic="true">
            <p className="break-words text-sm text-muted-foreground">{guests.length === 1 ? name(guests[0].personId) + '’s share' : 'Others’ share'}</p>
            <p className="mb-4 mt-1 font-mono text-3xl font-semibold tracking-tight">{money(sharedTotal)}</p>
          </div>
          {shares.map((share) => <details key={share.personId} className="border-t py-1">
            <summary className="cursor-pointer py-2 text-sm">
              <span>{share.personId === owner?.id ? 'Your share' : name(share.personId) + '’s share'}</span>
              <span className="float-right ml-2 font-mono">{money(share.amountCents)}</span>
            </summary>
            <dl className="space-y-1 pb-3 text-xs text-muted-foreground">
              {share.lines.map((line) => <div className="flex justify-between gap-3" key={line.itemIndexes.join(',')}>
                <dt className="min-w-0 break-words">{line.itemIndexes.map((i) => receipt.items[i].description).join(' + ')}</dt><dd>{money(line.amountCents)}</dd>
              </div>)}
              <div className="flex justify-between gap-3"><dt>Tax and tip · equal share</dt><dd>{money(share.taxTipCents)}</dd></div>
            </dl>
          </details>)}
        </>}
        {state.error && <p role="alert" className="mt-4 text-sm text-destructive">{state.error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button type="button" size="lg" disabled={pending || !!problem} onClick={save}>{pending ? 'Saving…' : 'Save split'}</Button>
          {onBack && <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>Review receipt</Button>}
        </div>
      </section>
    </div>
  );
}
