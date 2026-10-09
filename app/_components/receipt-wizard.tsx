'use client';

import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toCents, formatUSD, formatCents, tryParseDollars } from '@/lib/money';
import { computeItemShares, type ResolvedShare } from '@/lib/split';
import { totalsMismatch } from '@/lib/receipt/compare';
import {
  uploadReceipt,
  getReceipt,
  saveReceiptReview,
  removeReceipt,
} from '@/app/_actions/receipts';
import { saveItemSplit } from '@/app/_actions/splits';
import {
  RECEIPT_MIME_TYPES,
  RECEIPT_MAX_BYTES,
  RECEIPT_MAX_IMAGES,
  type UploadReceiptState,
  type ReceiptReviewState,
  type ItemSplitState,
} from '@/app/_lib/schema';
import type { ReceiptView } from '@/db/queries';
import type { PersonOption } from '@/app/_components/split-editor';
import { useIsDemo } from '@/app/_lib/use-demo';

type WizardStep = 'upload' | 'review' | 'assign';

const initialUpload: UploadReceiptState = {};
const initialReview: ReceiptReviewState = {};
const initialItemSplit: ItemSplitState = {};

// The receipt wizard: upload → extract → review → assign → save. The
// receipt row persists from a successful upload on, so closing mid-way
// leaves an attached receipt without an item split. Once a receipt exists
// the upload step is done (re-extraction is deferred); back/forward moves
// between review and assign.
export function ReceiptWizardDialog({
  transactionId,
  description,
  date,
  amountCents,
  persons,
  existingReceipt,
  trigger,
}: {
  transactionId: string;
  description: string;
  date: string;
  amountCents: number;
  persons: PersonOption[];
  existingReceipt: ReceiptView | null;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {existingReceipt ? 'Receipt' : 'Attach receipt'}
          </DialogTitle>
          <DialogDescription className="flex items-start justify-between gap-3">
            {/* Clamp to two lines: the full description stays visible in the
                expanded row detail, so losing the tail here is fine. */}
            <span className="min-w-0 line-clamp-2">{description}</span>
            <span className="shrink-0 font-mono text-foreground">
              {formatUSD(toCents(amountCents))}
              <span className="ml-2 text-xs text-muted-foreground">{date}</span>
            </span>
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ReceiptWizard
            transactionId={transactionId}
            amountCents={amountCents}
            persons={persons}
            existingReceipt={existingReceipt}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReceiptWizard({
  transactionId,
  amountCents,
  persons,
  existingReceipt,
  onDone,
}: {
  transactionId: string;
  amountCents: number;
  persons: PersonOption[];
  existingReceipt: ReceiptView | null;
  onDone: () => void;
}) {
  const [receipt, setReceipt] = useState<ReceiptView | null>(existingReceipt);
  const [step, setStep] = useState<WizardStep>(
    existingReceipt ? 'review' : 'upload',
  );

  // Actions revalidate '/' and the refreshed page re-renders this dialog
  // with fresh existingReceipt data; adopt it whenever it arrives. The
  // explicit getReceipt in reloadThen is belt-and-suspenders — the
  // revalidation can interrupt that in-flight call, so the prop sync is
  // what actually guarantees the step advances with data.
  useEffect(() => {
    if (existingReceipt) setReceipt(existingReceipt);
  }, [existingReceipt]);

  // Pull fresh server state after upload/extract or a review save, then
  // advance. The callback keeps step transitions tied to data arrival.
  const reloadThen = (next: WizardStep) => {
    setStep(next);
    startTransition(async () => {
      const fresh = await getReceipt(transactionId);
      if (fresh) setReceipt(fresh);
    });
  };

  if (step === 'upload' || !receipt) {
    return (
      <UploadStep
        transactionId={transactionId}
        onStored={() => reloadThen('review')}
      />
    );
  }

  if (step === 'review') {
    return (
      <ReviewStep
        key={receipt.id}
        receipt={receipt}
        amountCents={amountCents}
        onSaved={() => reloadThen('assign')}
      />
    );
  }

  return (
    <AssignStep
      key={receipt.id}
      receipt={receipt}
      persons={persons}
      onBack={() => setStep('review')}
      onSaved={onDone}
    />
  );
}

function UploadStep({
  transactionId,
  onStored,
}: {
  transactionId: string;
  onStored: () => void;
}) {
  // Files held in client state and dispatched with a manually built FormData
  // (see import-form.tsx): React 19 resets uncontrolled forms after a form
  // action runs, which would drop them — and the retry-after-failure path
  // resends these same Files without reselecting. Several images of one
  // order are allowed (multi-page receipts, app-order screenshots).
  const [files, setFiles] = useState<File[]>([]);
  const [state, dispatch, pending] = useActionState(uploadReceipt, initialUpload);
  const demo = useIsDemo();

  // Demo visitors rarely have a receipt photo to hand; offer a synthetic one.
  async function pickSamplePhoto() {
    const res = await fetch('/demo/sample-receipt.png');
    const blob = await res.blob();
    setFiles([new File([blob], 'sample-receipt.png', { type: 'image/png' })]);
  }
  const previewUrls = useMemo(
    () => files.map((f) => URL.createObjectURL(f)),
    [files],
  );
  useEffect(() => {
    return () => {
      for (const url of previewUrls) URL.revokeObjectURL(url);
    };
  }, [previewUrls]);

  useEffect(() => {
    if (state.ok) onStored();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const clientProblem =
    files.length === 0
      ? null
      : files.length > RECEIPT_MAX_IMAGES
        ? `Up to ${RECEIPT_MAX_IMAGES} images per receipt`
        : files.some(
              (f) => !RECEIPT_MIME_TYPES.includes(f.type as (typeof RECEIPT_MIME_TYPES)[number]),
            )
          ? 'Only JPG and PNG images are supported'
          : files.some((f) => f.size > RECEIPT_MAX_BYTES)
            ? 'Each image must be under the 10MB limit'
            : null;

  function submit(mode: 'extract' | 'manual') {
    if (files.length === 0) return;
    const fd = new FormData();
    fd.set('transactionId', transactionId);
    for (const f of files) fd.append('file', f);
    fd.set('mode', mode);
    startTransition(() => dispatch(fd));
  }

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Upload a photo of a receipt or a screenshot of an app order (Walmart,
        Weee, Instacart, Amazon…) — the items are read out for you to split.
        Add several images for a long receipt or an order split across screens.
      </p>
      {demo && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Extraction is simulated in this demo: any image reads as a sample
            dinner receipt sized to this transaction.
          </span>
          <Button type="button" variant="outline" size="xs" onClick={pickSamplePhoto}>
            Use a sample photo
          </Button>
        </div>
      )}
      <Input
        type="file"
        accept="image/jpeg,image/png"
        multiple
        onChange={(e) => setFiles(e.target.files ? [...e.target.files] : [])}
        aria-label="Receipt or order screenshots"
      />
      {previewUrls.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {previewUrls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt={`Selected image ${i + 1}`}
              className="max-h-40 rounded-lg border object-contain"
            />
          ))}
        </div>
      )}
      {files.length > 0 && !clientProblem && (
        <p className="text-[11px] text-muted-foreground">
          {files.length} image{files.length === 1 ? '' : 's'} selected
        </p>
      )}
      {clientProblem && <p className="text-xs text-destructive">{clientProblem}</p>}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}

      {state.extractionFailed ? (
        // Fork 10: extraction failing is a fork in the road, not a wall.
        <div className="grid gap-2 rounded-lg border border-dashed px-3 py-2.5">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
            <span>
              Couldn&apos;t read the receipt: {state.extractionFailed}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => submit('extract')}
              disabled={files.length === 0 || pending}
            >
              {pending ? 'Retrying…' : 'Try extraction again'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => submit('manual')}
              disabled={files.length === 0 || pending}
            >
              I&apos;ll type the items myself
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-3">
          {pending && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-3 animate-spin rounded-full border border-muted-foreground/40 border-t-foreground"
              />
              Uploading and reading the receipt… usually a few seconds
            </span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => submit('extract')}
            disabled={files.length === 0 || !!clientProblem || pending}
          >
            {pending ? 'Extracting…' : 'Upload & extract'}
          </Button>
        </div>
      )}
    </div>
  );
}

type ItemDraft = {
  key: number;
  description: string;
  quantity: string;
  amount: string;
};

// Review the extraction draft: everything is editable, the LLM is not the
// source of truth. Saving replaces the receipt's fields and items, then
// hands off to assignment.
function ReviewStep({
  receipt,
  amountCents,
  onSaved,
}: {
  receipt: ReceiptView;
  amountCents: number;
  onSaved: () => void;
}) {
  const [state, dispatch, pending] = useActionState(saveReceiptReview, initialReview);
  const [merchant, setMerchant] = useState(receipt.merchant);
  const [date, setDate] = useState(receipt.date ?? '');
  const [subtotal, setSubtotal] = useState(
    receipt.subtotalCents ? formatCents(toCents(receipt.subtotalCents)) : '',
  );
  const [tax, setTax] = useState(
    receipt.taxCents ? formatCents(toCents(receipt.taxCents)) : '',
  );
  const [tip, setTip] = useState(
    receipt.tipCents ? formatCents(toCents(receipt.tipCents)) : '',
  );
  const [total, setTotal] = useState(
    receipt.totalCents ? formatCents(toCents(receipt.totalCents)) : '',
  );
  const [note, setNote] = useState(receipt.mismatchNote ?? '');
  const [items, setItems] = useState<ItemDraft[]>(() =>
    receipt.items.length > 0
      ? receipt.items.map((item, i) => ({
          key: i,
          description: item.description,
          quantity: String(item.quantity),
          amount: formatCents(toCents(item.amountCents)),
        }))
      : [{ key: 0, description: '', quantity: '1', amount: '' }],
  );
  const [nextKey, setNextKey] = useState(items.length);

  useEffect(() => {
    if (state.ok) onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const money = (text: string) =>
    text.trim() === '' ? 0 : tryParseDollars(text);

  const parsed = useMemo(() => {
    const subtotalCents = money(subtotal);
    const taxCents = money(tax);
    const tipCents = money(tip);
    const totalCents = money(total);
    const itemCents = items.map((i) => money(i.amount));
    const quantities = items.map((i) => {
      const q = i.quantity.trim() === '' ? 1 : Number(i.quantity);
      return Number.isFinite(q) && q > 0 ? q : null;
    });

    let problem: string | null = null;
    if ([subtotalCents, taxCents, tipCents, totalCents].some((v) => v === null || v < 0)) {
      problem = 'Totals must be dollar amounts';
    } else if (itemCents.some((v) => v === null || v < 0)) {
      problem = 'Every item needs a dollar amount';
    } else if (items.some((i) => i.description.trim() === '')) {
      problem = 'Every item needs a description';
    } else if (quantities.some((q) => q === null)) {
      problem = 'Quantities must be positive numbers';
    } else if (items.length === 0) {
      problem = 'Add at least one item';
    } else if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problem = 'Date must be YYYY-MM-DD';
    }

    const itemsSum =
      problem === null ? (itemCents as number[]).reduce((a, b) => a + b, 0) : 0;
    return {
      problem,
      subtotalCents: subtotalCents ?? 0,
      taxCents: taxCents ?? 0,
      tipCents: tipCents ?? 0,
      totalCents: totalCents ?? 0,
      itemsSum,
      quantities: quantities as (number | null)[],
      itemCents: itemCents as (number | null)[],
    };
  }, [subtotal, tax, tip, total, items, date]);

  const mismatch =
    parsed.problem === null && totalsMismatch(parsed.totalCents, amountCents);
  // Internal consistency hint (items + tax + tip vs printed total): softer
  // than the transaction mismatch, often explained by per-line rounding.
  const internalDelta =
    parsed.problem === null
      ? parsed.itemsSum + parsed.taxCents + parsed.tipCents - parsed.totalCents
      : 0;

  function updateItem(key: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function save() {
    if (parsed.problem) return;
    const payload = JSON.stringify({
      receiptId: receipt.id,
      transactionId: receipt.transactionId,
      merchant: merchant.trim(),
      date: date === '' ? null : date,
      subtotalCents: parsed.subtotalCents,
      taxCents: parsed.taxCents,
      tipCents: parsed.tipCents,
      totalCents: parsed.totalCents,
      mismatchNote: mismatch && note.trim() !== '' ? note.trim() : null,
      items: items.map((item, i) => ({
        description: item.description.trim(),
        quantity: parsed.quantities[i] ?? 1,
        amountCents: parsed.itemCents[i] ?? 0,
      })),
    });
    const fd = new FormData();
    fd.set('payload', payload);
    startTransition(() => dispatch(fd));
  }

  const moneyField = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </Label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
          $
        </span>
        <Input
          id={id}
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder="0.00"
          className="h-7 pl-5 text-right font-mono text-xs"
        />
      </div>
    </div>
  );

  return (
    <div className="grid gap-3">
      {!receipt.extracted && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Manual entry — type the items from the paper receipt.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label htmlFor="rcpt-merchant" className="text-[11px] text-muted-foreground">
            Merchant
          </Label>
          <Input
            id="rcpt-merchant"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder="Store name"
            className="h-7 text-xs"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="rcpt-date" className="text-[11px] text-muted-foreground">
            Receipt date
          </Label>
          <Input
            id="rcpt-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-7 font-mono text-xs"
          />
        </div>
      </div>

      {/* Items */}
      <div className="overflow-hidden rounded-lg border">
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5 px-2 py-1">
              <Input
                value={item.description}
                onChange={(e) => updateItem(item.key, { description: e.target.value })}
                placeholder="Item"
                aria-label="Item description"
                className="h-6.5 flex-1 border-transparent bg-transparent px-1 text-xs shadow-none dark:bg-transparent"
              />
              <Input
                value={item.quantity}
                onChange={(e) => updateItem(item.key, { quantity: e.target.value })}
                aria-label="Quantity"
                className="h-6.5 w-10 border-transparent bg-transparent px-1 text-right font-mono text-[11px] text-muted-foreground shadow-none dark:bg-transparent"
              />
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-1 flex items-center text-[11px] text-muted-foreground">
                  $
                </span>
                <Input
                  value={item.amount}
                  onChange={(e) => updateItem(item.key, { amount: e.target.value })}
                  placeholder="0.00"
                  aria-label="Item amount"
                  className="h-6.5 w-20 border-transparent bg-transparent pl-4 pr-1 text-right font-mono text-xs shadow-none dark:bg-transparent"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${item.description || 'item'}`}
                onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            setItems((prev) => [
              ...prev,
              { key: nextKey, description: '', quantity: '1', amount: '' },
            ]);
            setNextKey((k) => k + 1);
          }}
          className="flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden />
          Add item
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {moneyField('rcpt-subtotal', 'Subtotal', subtotal, setSubtotal)}
        {moneyField('rcpt-tax', 'Tax', tax, setTax)}
        {moneyField('rcpt-tip', 'Tip', tip, setTip)}
        {moneyField('rcpt-total', 'Total', total, setTotal)}
      </div>

      {parsed.problem === null && internalDelta !== 0 && (
        <p className="text-[11px] text-muted-foreground">
          Items + tax + tip come to{' '}
          <span className="font-mono">
            {formatUSD(toCents(parsed.itemsSum + parsed.taxCents + parsed.tipCents))}
          </span>
          , {formatUSD(toCents(Math.abs(internalDelta)))}{' '}
          {internalDelta > 0 ? 'over' : 'under'} the stated total.
        </p>
      )}

      {mismatch && (
        <div className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
          <p className="flex items-start gap-2 text-xs">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
            <span>
              Receipt total{' '}
              <strong className="font-mono">{formatUSD(toCents(parsed.totalCents))}</strong>{' '}
              differs from the transaction&apos;s{' '}
              <strong className="font-mono">
                {formatUSD(toCents(Math.abs(amountCents)))}
              </strong>
              . Often a tip added after printing — you can still save.
            </span>
          </p>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note, e.g. tip added on card"
            aria-label="Mismatch note"
            className="h-7 text-xs"
          />
        </div>
      )}

      {parsed.problem && (
        <p className="text-xs text-muted-foreground">{parsed.problem}</p>
      )}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}

      <div className="flex items-center justify-between">
        {/* Removing the receipt also removes an item split derived from it
            and deletes the stored image. */}
        <form action={removeReceipt}>
          <input type="hidden" name="transactionId" value={receipt.transactionId} />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 data-icon="inline-start" />
            Remove receipt
          </Button>
        </form>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={pending || parsed.problem !== null}
        >
          {pending ? 'Saving…' : 'Continue to assignment'}
        </Button>
      </div>
    </div>
  );
}

// Assign each item to one or more people; an item splits equally among its
// assignees, and unassigned items stay the owner's. The preview runs the
// same computeItemShares the Server Action runs, so what is shown is what
// saves.
function AssignStep({
  receipt,
  persons,
  onBack,
  onSaved,
}: {
  receipt: ReceiptView;
  persons: PersonOption[];
  onBack: () => void;
  onSaved: () => void;
}) {
  const [state, dispatch, pending] = useActionState(saveItemSplit, initialItemSplit);
  const [assignments, setAssignments] = useState<Map<string, Set<string>>>(
    () =>
      new Map(
        receipt.items.map((item) => [
          item.id,
          new Set(
            item.assignedPersonIds.filter((id) =>
              persons.some((p) => p.id === id),
            ),
          ),
        ]),
      ),
  );
  // The "brush": who a tap assigns. Start with everyone selected so the
  // common case (share everything) is one "Apply to all" tap away.
  const [active, setActive] = useState<Set<string>>(
    () => new Set(persons.map((p) => p.id)),
  );

  useEffect(() => {
    if (state.ok) onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const owner = persons.find((p) => p.isOwner);

  const toggleActive = (personId: string) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });

  // A tap paints the active set onto an item (overwrite). Applying to all
  // items covers the fully-shared receipt; the per-item clear (x) hands an
  // item back to the owner.
  const paintItem = (itemId: string) =>
    setAssignments((prev) => new Map(prev).set(itemId, new Set(active)));
  const paintAll = () =>
    setAssignments((prev) => {
      const next = new Map(prev);
      for (const item of receipt.items) next.set(item.id, new Set(active));
      return next;
    });
  const clearItem = (itemId: string) =>
    setAssignments((prev) => new Map(prev).set(itemId, new Set()));

  const preview = useMemo((): { shares: ResolvedShare[] } | { problem: string } => {
    if (!owner) return { problem: 'Owner person missing' };
    try {
      return {
        shares: computeItemShares({
          ownerId: owner.id,
          taxCents: toCents(receipt.taxCents),
          tipCents: toCents(receipt.tipCents),
          items: receipt.items.map((item) => ({
            amountCents: toCents(item.amountCents),
            assigneePersonIds: [...(assignments.get(item.id) ?? [])],
          })),
          personOrder: persons.map((p) => p.id),
        }),
      };
    } catch (err) {
      return {
        problem: err instanceof Error ? err.message : 'Invalid assignments',
      };
    }
  }, [assignments, owner, persons, receipt]);

  function save() {
    const payload = JSON.stringify({
      transactionId: receipt.transactionId,
      receiptId: receipt.id,
      assignments: receipt.items.map((item) => ({
        itemId: item.id,
        personIds: [...(assignments.get(item.id) ?? [])],
      })),
    });
    const fd = new FormData();
    fd.set('payload', payload);
    startTransition(() => dispatch(fd));
  }

  const nameById = new Map(persons.map((p) => [p.id, p.name]));

  const activeLabel = persons
    .filter((p) => active.has(p.id))
    .map((p) => (p.isOwner ? 'me' : p.name))
    .join(' · ');

  return (
    <div className="grid gap-3">
      {/* The brush: choose who a tap assigns, then tap items. */}
      <div className="grid gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Assigning to
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActive(new Set(persons.map((p) => p.id)))}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Everyone
            </button>
            {owner && (
              <button
                type="button"
                onClick={() => setActive(new Set([owner.id]))}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Just me
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {persons.map((p) => {
            const on = active.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleActive(p.id)}
                aria-pressed={on}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-xs transition-colors',
                  on
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {p.isOwner ? 'me' : p.name}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            Tap an item below to give it{' '}
            <span className="font-medium text-foreground">
              {active.size === 0 ? 'nobody (yours)' : activeLabel}
            </span>
            .
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6.5 shrink-0 text-xs"
            onClick={paintAll}
          >
            Apply to all
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <ul className="divide-y">
          {receipt.items.map((item) => {
            const assigned = assignments.get(item.id) ?? new Set<string>();
            const names = persons
              .filter((p) => assigned.has(p.id))
              .map((p) => (p.isOwner ? 'me' : p.name));
            return (
              <li key={item.id} className="flex items-stretch">
                {/* The whole row is the tap target that paints the active
                    brush onto this item. */}
                <button
                  type="button"
                  onClick={() => paintItem(item.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50"
                  aria-label={`Assign ${item.description} to ${active.size === 0 ? 'nobody' : activeLabel}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {item.description}
                  </span>
                  <span className="shrink-0 font-mono text-xs">
                    {formatUSD(toCents(item.amountCents))}
                  </span>
                  <span
                    className={cn(
                      'w-32 shrink-0 truncate text-right text-[11px]',
                      names.length === 0
                        ? 'text-muted-foreground/70 italic'
                        : 'text-primary',
                    )}
                  >
                    {names.length === 0 ? 'yours' : names.join(' · ')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => clearItem(item.id)}
                  disabled={assigned.size === 0}
                  aria-label={`Clear assignees on ${item.description}`}
                  className="flex shrink-0 items-center px-2 text-muted-foreground/50 transition-colors hover:text-destructive disabled:opacity-0"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Unassigned items stay yours. Tax {formatUSD(toCents(receipt.taxCents))} and
        tip {formatUSD(toCents(receipt.tipCents))} split equally among everyone
        holding an item.
      </p>

      {'shares' in preview ? (
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Resolved shares
          </p>
          <ul className="grid gap-0.5">
            {preview.shares.map((s) => (
              <li key={s.personId} className="flex items-baseline justify-between text-xs">
                <span>
                  {nameById.get(s.personId) ?? '(unknown)'}
                  {s.personId === owner?.id && (
                    <span className="ml-1 text-muted-foreground">(you — not owed)</span>
                  )}
                </span>
                <span className="font-mono">{formatUSD(toCents(s.amountCents))}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-destructive">{preview.problem}</p>
      )}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={pending || !('shares' in preview)}
        >
          {pending ? 'Saving…' : 'Save split'}
        </Button>
      </div>
    </div>
  );
}

// The phase-5 row-hover attach/view affordance ("Rcpt") lived here; phase 6
// consolidated it into the expanded row's receipt block (transaction-
// detail.tsx), which opens this same wizard dialog.
