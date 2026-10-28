'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { put, del, issueSignedToken, presignUrl } from '@vercel/blob';
import {
  getTransactionForSplit,
  getReceiptByTransactionId,
  insertReceiptWithItems,
  updateReceiptWithItems,
  deleteReceiptByTransactionId,
  type ReceiptView,
} from '@/db/queries';
import { extractReceipt, ExtractionError } from '@/lib/receipt/extract';
import { CENTS_TO_MINOR } from '@/lib/money';
import { isDemoMode } from '@/lib/demo-mode';
import { cannedExtraction } from '@/lib/demo/canned-receipt';
import {
  RECEIPT_MIME_TYPES,
  RECEIPT_MAX_BYTES,
  RECEIPT_MAX_IMAGES,
  receiptReviewSchema,
  type UploadReceiptState,
  type ReceiptReviewState,
} from '@/app/_lib/schema';
import type { ReceiptImageInput } from '@/lib/receipt/extract';
import { requireUser } from '@/app/_lib/session';

// Upload a receipt image for a transaction and extract its line items.
// mode 'extract' runs Gemini; a failure deletes the just-uploaded blob and
// reports extractionFailed so the wizard can offer retry (the File is still
// in client state) or manual entry. mode 'manual' skips the LLM entirely
// and persists an empty draft for the review step — the LLM is never a
// gate. Returns ids rather than the full view; the wizard reloads data
// through getReceipt.
export async function uploadReceipt(
  _prev: UploadReceiptState,
  formData: FormData,
): Promise<UploadReceiptState> {
  await requireUser();
  const transactionId = formData.get('transactionId');
  const files = formData
    .getAll('file')
    .filter((f): f is File => f instanceof File && f.size > 0);
  const mode = formData.get('mode') === 'manual' ? 'manual' : 'extract';
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    return { error: 'Missing transaction' };
  }
  if (files.length === 0) {
    return { error: 'Choose at least one image' };
  }
  if (files.length > RECEIPT_MAX_IMAGES) {
    return { error: `Up to ${RECEIPT_MAX_IMAGES} images per receipt` };
  }
  for (const file of files) {
    if (!RECEIPT_MIME_TYPES.includes(file.type as (typeof RECEIPT_MIME_TYPES)[number])) {
      return { error: 'Only JPG and PNG images are supported' };
    }
    if (file.size > RECEIPT_MAX_BYTES) {
      return { error: 'Each image must be under the 10MB limit' };
    }
  }

  const transaction = await getTransactionForSplit(transactionId);
  if (!transaction) return { error: 'Transaction not found' };
  // Pending rows are provisional; a receipt waits for the posted row, which
  // takes this row over in place (same id), so nothing is lost by waiting.
  if (transaction.pending) return { error: 'Pending transactions can take a receipt once they post.' };
  if (await getReceiptByTransactionId(transactionId)) {
    return { error: 'This transaction already has a receipt' };
  }

  // Upload every image up front so the stored receipt keeps all of them.
  const uploaded: { url: string; image: ReceiptImageInput }[] = [];
  for (const [i, file] of files.entries()) {
    const mimeType = file.type as ReceiptImageInput['mimeType'];
    const bytes = Buffer.from(await file.arrayBuffer());
    const extension = mimeType === 'image/png' ? 'png' : 'jpg';
    const blob = await put(`receipts/${transactionId}-${i}.${extension}`, bytes, {
      access: 'private',
      contentType: mimeType,
      addRandomSuffix: true,
    });
    uploaded.push({ url: blob.url, image: { imageBase64: bytes.toString('base64'), mimeType } });
  }
  const blobUrls = uploaded.map((u) => u.url);
  const delAll = async () => {
    await Promise.all(
      blobUrls.map((url) => del(url).catch(() => {})),
    );
  };

  if (mode === 'manual') {
    const { receiptId } = await insertReceiptWithItems({
      transactionId,
      blobUrls,
      merchant: '',
      date: null,
      subtotalCents: 0,
      taxCents: 0,
      tipCents: 0,
      totalCents: 0,
      rawLlmResponse: null,
      items: [],
    });
    revalidatePath('/');
    return { ok: true, receiptId };
  }

  const startedAt = Date.now();
  try {
    // All images go in one extraction request — the model merges them, so
    // the free-tier quota cost is one call no matter how many images.
    const result = isDemoMode()
      ? await simulatedExtraction(transaction.amountCents)
      : await extractReceipt({ images: uploaded.map((u) => u.image) });
    // The model emits hundredths ("$4.99 -> 499"); the app stores thousandths
    // (minor units). Scale every extracted money value here, at the
    // extraction-to-persistence boundary, so the rate-limited prompt stays
    // untouched. rawLlmResponse keeps the model's literal output for debugging.
    const { receiptId } = await insertReceiptWithItems({
      transactionId,
      blobUrls,
      merchant: result.extraction.merchant,
      date: result.extraction.date,
      subtotalCents: result.extraction.subtotal_cents * CENTS_TO_MINOR,
      taxCents: result.extraction.tax_cents * CENTS_TO_MINOR,
      tipCents: result.extraction.tip_cents * CENTS_TO_MINOR,
      totalCents: result.extraction.total_cents * CENTS_TO_MINOR,
      rawLlmResponse: result.raw,
      items: result.extraction.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        amountCents: item.amount_cents * CENTS_TO_MINOR,
      })),
    });
    revalidatePath('/');
    // Operational trace: latency and free-tier token consumption per call.
    console.log(
      `[receipt-extract] ${Date.now() - startedAt}ms ${files.length} image(s)`,
      JSON.stringify(result.usage),
    );
    return {
      ok: true,
      receiptId,
      extractLatencyMs: Date.now() - startedAt,
      usage: result.usage,
    };
  } catch (err) {
    // No receipt row on failure: delete the orphaned blobs so retry starts
    // clean (best-effort — a leaked blob is a nuisance, not a bug).
    await delAll();
    return {
      extractionFailed:
        err instanceof ExtractionError
          ? err.message
          : 'Extraction failed unexpectedly',
    };
  }
}

// The public demo never calls Gemini (a 20-request daily free tier would not
// survive one afternoon of visitors): any image extracts to a sample receipt
// sized to the transaction. The pause lets the wizard's reading state show.
async function simulatedExtraction(amountMinor: number) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const extraction = cannedExtraction(Math.floor(Math.abs(amountMinor) / CENTS_TO_MINOR));
  return { extraction, raw: { simulated: true, ...extraction }, usage: null };
}

// The wizard's data (re)load: fresh receipt state after upload or edits.
export async function getReceipt(
  transactionId: string,
): Promise<ReceiptView | null> {
  await requireUser();
  return getReceiptByTransactionId(transactionId);
}

// Presign one private blob URL for short-lived viewing.
async function presignBlob(blobUrl: string): Promise<string> {
  const pathname = decodeURIComponent(
    new URL(blobUrl).pathname.replace(/^\//, ''),
  );
  const token = await issueSignedToken({
    pathname,
    operations: ['get'],
    validUntil: Date.now() + 10 * 60 * 1000,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'get',
    pathname,
    access: 'private',
  });
  return presignedUrl;
}

// Receipts are private blobs; viewers get short-lived presigned GET URLs
// minted server-side — one per image, in order. The canonical blob URLs
// never reach the client.
export async function getReceiptImageUrls(
  transactionId: string,
): Promise<{ urls: string[] } | { error: string }> {
  await requireUser();
  const receipt = await getReceiptByTransactionId(transactionId);
  if (!receipt) return { error: 'Receipt not found' };
  try {
    const urls = await Promise.all(receipt.blobUrls.map(presignBlob));
    return { urls };
  } catch {
    return { error: 'Could not generate a viewing link' };
  }
}

// Remove the receipt: the receipt row (items and assignments cascade), any
// item split derived from it, and the stored blob. Method splits survive.
export async function removeReceipt(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const transactionId = z.string().uuid().safeParse(formData.get('transactionId'));
  if (!transactionId.success) return { error: 'Invalid transaction.' };
  return attempt('removeReceipt', async () => {
    const removed = await deleteReceiptByTransactionId(transactionId.data);
    if (!removed) return { error: 'This row has no receipt to remove; it may already be removed.' };
    // Best-effort: an orphaned blob is a nuisance, not a correctness bug.
    await Promise.all(removed.blobUrls.map((url) => del(url).catch(() => {})));
    revalidatePath('/');
    revalidatePath('/people');
    return {
      ok: true,
      message: removed.itemSplitRemoved
        ? 'Receipt removed, and the item split made from it; the charge is all yours. Payments applied to it are credit again.'
        : 'Receipt removed.',
    };
  });
}

// Review-step save: persist corrected header fields and the item list
// (full replace, same policy as splits). The mismatch warning never blocks
// this — the optional note is stored alongside.
export async function saveReceiptReview(
  _prev: ReceiptReviewState,
  formData: FormData,
): Promise<ReceiptReviewState> {
  await requireUser();
  const raw = formData.get('payload');
  if (typeof raw !== 'string') return { error: 'Missing payload' };
  let parsed;
  try {
    parsed = receiptReviewSchema.safeParse(JSON.parse(raw));
  } catch {
    return { error: 'Malformed payload' };
  }
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid receipt' };
  }
  const payload = parsed.data;

  const existing = await getReceiptByTransactionId(payload.transactionId);
  if (!existing || existing.id !== payload.receiptId) {
    return { error: 'Receipt not found' };
  }

  await updateReceiptWithItems({
    receiptId: payload.receiptId,
    merchant: payload.merchant,
    date: payload.date,
    subtotalCents: payload.subtotalCents,
    taxCents: payload.taxCents,
    tipCents: payload.tipCents,
    totalCents: payload.totalCents,
    mismatchNote: payload.mismatchNote,
    items: payload.items,
  });
  revalidatePath('/');
  return { ok: true };
}
