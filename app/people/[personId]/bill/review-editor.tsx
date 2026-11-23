'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { BillDesignPicker } from '@/app/_components/bill-design-picker';
import { demoSharingNote, guestCopy, type BillDesign } from '@/lib/bill-design';
import { billLine, compareBills, composeBill, type BillReview, type ReviewItem, type ReviewSource } from '@/lib/bill-review';
import { formatUSD, toCents } from '@/lib/money';
import { guestCheckBalance } from '@/lib/share-summary';
import { SharedBill } from '@/share/app/_components/shared-bill';
import { confirmOlderBillItem, publishReviewedBill } from './actions';

const money = (n: number) => formatUSD(toCents(n));
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const sign = (i: {side: ReviewItem['side']}) => i.side === 'owed' ? 1 : -1;
const net = (rows: {side: ReviewItem['side']; outstandingCents: number}[]) => rows.reduce((s, i) => s + sign(i) * i.outstandingCents, 0);
const signed = (value: number) => guestCheckBalance(value) + ' ' + guestCopy.balance(value);

export function ReviewEditor({ data: initialData, version: initialVersion, grouped, billBase, demo }: { data: BillReview; version: string; grouped: boolean; billBase: string | null; demo: boolean }) {
  const [{ data, version }, setReview] = useState({ data: initialData, version: initialVersion });
  const [matchMessage, setMatchMessage] = useState('');
  const [undo, setUndo] = useState<{ billId: string; index: number } | null>(null);
  const [compareId, setCompareId] = useState(data.bills[0]?.id ?? '');
  const comparison = compareBills(data, compareId);
  const { previous, known, current, open, fresh } = comparison;
  const [selected, setSelected] = useState(() => new Set(fresh.map(i => i.shareId)));
  const [paper, setPaper] = useState<BillDesign>('classic');
  const [busyAction, setBusyAction] = useState<'match' | 'publish' | null>(null);
  const working = busyAction !== null;
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [href, setHref] = useState('');
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const request = useRef('');
  const [today] = useState(() => new Date());
  const { snapshot } = composeBill(data, comparison, selected, paper, grouped, today);
  const available = open.filter(i => !comparison.held.has(i.shareId));
  const carry = available.filter(i => known.get(i.shareId)?.billId === compareId);
  const other = available.filter(i => known.has(i.shareId) && known.get(i.shareId)?.billId !== compareId);
  const historic = previous?.items ?? [];
  const closed = historic.filter(i => i.source && current.get(i.source.shareId)?.outstandingCents === 0);
  const unknown = historic.filter(i => !i.candidates?.length && (!i.source || !current.has(i.source.shareId)));
  const pending = data.bills.flatMap(bill => bill.items.flatMap((item, index) =>
    item.candidates?.length ? [{ bill, item, index }] : []));
  const decisions = data.bills.flatMap(bill => bill.items.flatMap((item, index) =>
    item.editableMatch && (item.source || item.skipped) ? [{ bill, item, index }] : []));
  const [question] = pending;
  async function resolve(billId: string, index: number, shareId: string | null) {
    setBusyAction('match'); setError(''); setMatchMessage('');
    try {
      const result = await confirmOlderBillItem({ personId: data.personId, billId, line: index, shareId, version });
      if (!result.review) {
        setError(result.error); setStale(Boolean(result.stale)); return;
      }
      const next = compareBills(result.review.data, compareId);
      setSelected(before => new Set([...before].filter(id => !next.held.has(id) && known.has(id) === next.known.has(id))));
      setReview(result.review);
      setUndo(question?.bill.id === billId && question.index === index && shareId !== 'reopen' ? { billId, index } : null);
      if (shareId === 'reopen') {
        const reopened = result.review.data.bills.find(b => b.id === billId)?.items[index];
        setMatchMessage(reopened?.candidates?.length ? 'Ready to compare again.' : 'Decision cleared. No similar expense is available.');
      } else {
        setMatchMessage(shareId ? 'Saved as the same purchase. It counts as previously billed.' : 'Saved as different purchases. You can review them separately.');
      }
    } catch { setError('Couldn’t confirm the match. Try again.'); }
    finally { setBusyAction(null); }
  }
  function purchaseChoices(billId: string, index: number, candidates: ReviewSource[], dismissed = false) {
    return <div className="divide-y">
      {candidates.map(candidate => {
        const expense = current.get(candidate.shareId)!;
        return <div key={expense.shareId} role="group" aria-label={expense.description} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0 break-words text-sm">
            <strong>{expense.description}</strong>
            <small className="block text-muted-foreground">{dateLabel(expense.date)} · {money(expense.outstandingCents)} open</small>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={dismissed ? 'outline' : 'default'} onClick={() => resolve(billId, index, expense.shareId)}>Same purchase</Button>
            {!dismissed && candidates.length === 1 && <Button size="sm" variant="outline" onClick={() => resolve(billId, index, null)}>Different purchase</Button>}
          </div>
        </div>;
      })}
      {!dismissed && candidates.length > 1 && <Button size="sm" variant="outline" onClick={() => resolve(billId, index, null)}>None of these</Button>}
    </div>;
  }
  const payment = (side: ReviewItem['side']) => historic.reduce((sum, p) => {
    const item = p.source && current.get(p.source.shareId);
    return sum + (item && p.source && item.side === side ? item.cash - p.source.cash : 0);
  }, 0);
  const adjustment = net(carry) - net(historic) + payment('owed') - payment('owing');
  const change = (items: ReviewItem[], include: boolean) => {
    setSelected(before => {
      const next = new Set(before);
      for (const i of items) { if (include) next.add(i.shareId); else next.delete(i.shareId); }
      return next;
    });
  };
  const itemRows = (items: ReviewItem[], comparing: boolean) => <div className="review-items">
    {comparing && <div className="review-columns review-labels"><span>Expense</span><span>Last bill</span><span>Open now</span></div>}
    {items.map(i => {
      const prior = known.get(i.shareId);
      const context = comparing && prior ? billLine(i, prior).carried : null;
      return <label key={i.shareId} className={'review-columns ' + (comparing ? '' : 'single-amount')}>
        <span className="flex min-w-0 items-start gap-2">
          <input type="checkbox" checked={selected.has(i.shareId)} onChange={e => change([i], e.target.checked)} />
          <span className="min-w-0 break-words">{i.description}<small>{dateLabel(i.date)} · {i.side === 'owed' ? 'I paid' : 'You paid'}</small>
            {context && context.cash > 0 && <small>{money(context.cash)} {i.side === 'owed' ? 'received' : 'paid'} since that bill</small>}
            {context && (context.adjustment !== 0 || context.cash < 0) && <small>Balance adjusted since that bill</small>}
          </span>
        </span>
        {comparing && <span className="review-before">{money(prior!.item.outstandingCents)}</span>}
        <span className="review-amount">{money(i.outstandingCents)}</span>
      </label>;
    })}
  </div>;
  function section(title: string, items: ReviewItem[], comparing: boolean) {
    if (!items.length) return null;
    const included = items.filter(i => selected.has(i.shareId)).length;
    return <section className="review-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>{title}</h2>
        <Button variant="outline" size="sm" onClick={() => change(items, included !== items.length)}>
          {included === items.length ? 'Exclude all' : 'Include all'}
        </Button>
      </div>
      <details><summary>{comparing ? 'Compare items' : 'Choose items'} · {included} of {items.length} included</summary>{itemRows(items, comparing)}</details>
    </section>;
  }
  async function publish() {
    if (working || !selected.size) return;
    request.current ||= crypto.randomUUID();
    setBusyAction('publish'); setError('');
    try {
      const result = await publishReviewedBill({ personId: data.personId, requestId: request.current, selected: [...selected], compareId, version, paper, grouped });
      if ('href' in result) setHref(result.href);
      else { setError(result.error ?? 'Please try again.'); setStale('stale' in result); }
    } catch { setError('Couldn’t confirm the link. Try again.'); }
    finally { setBusyAction(null); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(new URL(href, location.origin).href); setCopied(true); }
    catch { setError('Select and copy the link below.'); }
  }
  if (href) return <section className="mx-auto mt-8 max-w-md space-y-5">
    <span className="guest-stamp">Shared bill</span><h1>Bill ready</h1>
    <p>{data.name} · {signed(snapshot.netCents)} · {selected.size} {selected.size === 1 ? 'item' : 'items'}</p>
    <div className="flex flex-wrap gap-2"><Button onClick={copy}>{copied ? <Check /> : <Link2 />}{copied ? 'Link copied' : 'Copy link'}</Button>
      <a className={buttonVariants({variant:'outline'})} href={href} target="_blank" rel="noreferrer">Open bill</a></div>
    {error && <p role="status">{error} <a className="underline" href={href}>{new URL(href, location.origin).href}</a></p>}
    <Link className="underline" href="/people/shared-bills">Shared bill history</Link>
  </section>;
  return <>
    <h1 className="my-5">Create bill</h1>
    <div className="review-layout">
      <fieldset disabled={working} className="min-w-0 space-y-5">
        <h2>Review with {data.name}</h2>
        {question && <section className="review-section" aria-label="Older bill matches">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2>{question.item.candidates!.length === 1 ? 'Same purchase?' : 'Which expense was on this bill?'}</h2>
            {pending.length > 1 && <small>{pending.length} to review</small>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Possible repeats stay off your draft until you decide.</p>
          <div className="mt-3 border-y py-3">
            <p className="mb-1 text-xs text-muted-foreground">On the bill shared {dateLabel(question.bill.date)}</p>
            <strong className="text-sm">{question.item.description}</strong>
            <small className="block text-muted-foreground">{dateLabel(question.item.date)} · {money(question.item.outstandingCents)} on that bill</small>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">In your expenses</p>
          {purchaseChoices(question.bill.id, question.index, question.item.candidates!)}
        </section>}
        {decisions.length > 0 && <details className="review-section">
          <summary>Past decisions · {decisions.length}</summary>
          {decisions.map(({ bill, item, index }) => <div key={bill.id + index} className="border-t py-3 text-sm">
            <small className="block text-muted-foreground">Bill shared {dateLabel(bill.date)}</small>
            <strong>{item.description}</strong> · {dateLabel(item.date)} · {money(item.outstandingCents)}
            {item.source ? <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <span>Same purchase as {current.get(item.source.shareId)?.description ?? 'a saved expense'}</span>
              <Button size="sm" variant="outline" onClick={() => resolve(bill.id, index, null)}>Mark as different</Button>
            </div> : <>
              <p className="mt-1 text-muted-foreground">Marked as different</p>
              {item.alternatives?.length ? purchaseChoices(bill.id, index, item.alternatives, true) :
                <p className="text-xs text-muted-foreground">No similar expense is available.</p>}
            </>}
          </div>)}
        </details>}
        {matchMessage && <div className="flex items-center gap-3 text-sm">
          <p role="status">{matchMessage}</p>
          {undo && <Button size="sm" variant="outline" onClick={() => resolve(undo.billId, undo.index, 'reopen')}>Undo</Button>}
        </div>}
        {previous && <section className="review-section">
          <label className="grid gap-2">Previous bill
            <select value={compareId} onChange={e => setCompareId(e.target.value)}>
              {data.bills.map((b, index) => <option value={b.id} key={b.id}>{dateLabel(b.date)} · {signed(net(b.items))} · #{data.bills.length-index}</option>)}
            </select>
          </label>
          <p className="mt-3 text-sm">{historic.length} items · Original total <strong>{signed(net(historic))}</strong></p>
          {previous.items.some(i => i.recognized) && <p className="text-sm text-muted-foreground">{previous.items.filter(i => i.recognized).length} matched automatically to your expenses</p>}
          {previous.tracked && <div className="text-sm text-muted-foreground">
            {(['owed','owing'] as const).map(side => payment(side) > 0 && <p key={side}>{side === 'owed' ? 'Payments received' : 'Payments sent'} · {money(payment(side))}</p>)}
            {adjustment !== 0 && <p>Other balance changes · {money(adjustment)}</p>}
            <p>Still open · {signed(net(carry))}</p>
          </div>}
          {closed.length > 0 && <details><summary>Settled items · {closed.length}</summary>{closed.map((p, i) => <p key={i} className="review-history-line">{p.description}<span>{money(p.outstandingCents)} → {money(0)}</span></p>)}</details>}
          {unknown.length > 0 && <details><summary>{previous.tracked ? 'Unavailable items' : 'Unmatched earlier entries'} · {unknown.length}</summary>
            <p className="mb-2 text-xs text-muted-foreground">{previous.tracked ? 'These entries are no longer in your expenses.' : 'Review these earlier entries when choosing expenses for this bill.'}</p>
            {unknown.map((p, i) => <p key={i} className="review-history-line">{p.description}<small>{dateLabel(p.date)} · {p.side === 'owed' ? 'I paid' : 'You paid'} · {money(p.outstandingCents)}</small></p>)}
          </details>}
        </section>}
        {section(previous?.tracked === false ? 'Current items to review' : 'New items', fresh, false)}
        {section('From the previous bill', carry, true)}
        {section('On other earlier bills', other, true)}
        {!open.length && <p>Everything is settled.</p>}
      </fieldset>
      <section className="review-preview">
        <div className="flex items-center justify-between gap-3"><h2>Recipient preview</h2><BillDesignPicker design={paper} onChange={setPaper} name={data.name} net={snapshot.netCents} /></div>
        <div className="bill-proof bill-paper mt-3" data-paper={paper}><div className="bill-proof-body">
          <span className="guest-stamp">Shared bill</span><h3>{guestCopy.heading(data.name)}</h3>
          {(['owed','owing'] as const).map(side => {
            const lines = snapshot[side]; if (!lines.length) return null;
            const subtotal = (carry: boolean) => lines.reduce((s,l) => s + (Boolean(l.carried) === carry ? l.outstandingCents : 0), 0);
            return <div key={side} className="mb-3 text-sm"><b>{side === 'owed' ? 'What I paid' : 'What you paid'}</b>
              {subtotal(true) > 0 && <div className="flex justify-between"><span>From earlier bills</span>{guestCheckBalance(subtotal(true))}</div>}
              {subtotal(false) > 0 && <div className="flex justify-between"><span>Current items</span>{guestCheckBalance(subtotal(false))}</div>}
            </div>;
          })}
          <p>Total <strong>{signed(snapshot.netCents)}</strong></p>
        </div></div>
        {selected.size > 0 && <details onToggle={e => setPreviewOpen(e.currentTarget.open)}><summary>Full preview · {selected.size} items</summary>{previewOpen && <SharedBill embedded snapshot={snapshot} billBase={billBase} note={demo ? demoSharingNote : undefined} />}</details>}
        <Button className="mt-4 w-full" disabled={!selected.size || working || stale || billBase === null} onClick={publish}><Link2 />{busyAction === 'publish' ? 'Creating…' : 'Create link'}</Button>
        {!selected.size && open.length > 0 && <p className="mt-2 text-sm" role="status">Include at least one item to create a link.</p>}
        {error && <p role="alert" className="mt-2">{error} {stale && <Button variant="outline" onClick={() => window.location.reload()}>Refresh draft</Button>}</p>}
        <p className="mt-3 text-xs text-muted-foreground">{billBase === null ? 'Bill site unavailable.' : demo ? demoSharingNote : 'Recipients can view this bill on the separate bill site.'}</p>
      </section>
    </div>
  </>;
}
