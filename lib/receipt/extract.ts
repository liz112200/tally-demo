// Receipt line-item extraction via Gemini vision.
//
// PRIVACY NOTE (free tier): Gemini API free-tier prompts — including the
// receipt images sent here — may be used by Google for model training.
// Acceptable for the owner's personal receipts in v1; this MUST be
// revisited (paid tier or explicit opt-out) before any multi-user mode.
//
// The model output is a first draft, never the source of truth: the caller
// shows it in a review UI where the user corrects it before anything is
// committed. This module only guarantees the draft is well-formed
// (structurally valid JSON matching extractionSchema).
import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from '@google/generative-ai';
import { z } from 'zod';

// Verified against ListModels on 2026-07-17; the stated phase-5 model id
// exists and serves this project's key.
export const RECEIPT_MODEL_ID = 'gemini-3.5-flash';

export const extractionItemSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.number().default(1),
  amount_cents: z.number().int(),
});

export const extractionSchema = z.object({
  merchant: z.string(),
  // ISO yyyy-mm-dd when the model can read one, else null.
  date: z.string().nullable(),
  items: z.array(extractionItemSchema),
  subtotal_cents: z.number().int(),
  tax_cents: z.number().int(),
  tip_cents: z.number().int(),
  total_cents: z.number().int(),
});

export type Extraction = z.infer<typeof extractionSchema>;

// The prompt pins down the two failure modes that matter for money math:
// amounts must be integer cents (never dollar floats), and per-line amounts
// must be the line TOTAL (so quantity is display-only and the sum check
// works). Everything else — missed items, misread merchant — is left to
// the human review step.
export const EXTRACTION_PROMPT = `Extract the line items from the image(s). Each image is either a store receipt OR a screenshot of an online / delivery-app order (e.g. Walmart, Weee, Instacart, Amazon). Read whichever it is. If several images are given, they are pages or screenshots of ONE order — combine everything into a single result and take the totals from whichever image shows them.

Rules:
- All monetary values are integer US cents: $4.99 becomes 499. Never use decimals.
- Each item's amount_cents is the LINE TOTAL for that item (quantity already multiplied in), exactly as shown. If only a unit price and a quantity are shown, multiply them.
- quantity is the count or weight for the line; use 1 when not shown.
- Include every purchased line item, including duplicates. Ignore non-purchase rows that carry no charge: "substituted"/"out of stock"/"refunded" notes, delivery-status text, and $0 promo lines.
- subtotal_cents is the items subtotal. Put sales tax in tax_cents. Put any tip/gratuity AND delivery, service, or bag fees together in tip_cents (they are shared costs split the same way). total_cents is the final charged total. Use 0 for anything not shown.
- date is the receipt/order date as YYYY-MM-DD, or null if unreadable. Two-digit years are 20xx.
- merchant is the store or app name as shown; use "" if unreadable.
- Do not invent items, fees, or totals that are not shown.`;

// Gemini structured output: the response is constrained to this schema and
// returned as application/json, so no function-calling machinery is needed.
const responseSchema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    merchant: { type: SchemaType.STRING },
    date: { type: SchemaType.STRING, nullable: true },
    items: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          description: { type: SchemaType.STRING },
          quantity: { type: SchemaType.NUMBER },
          amount_cents: { type: SchemaType.INTEGER },
        },
        required: ['description', 'amount_cents'],
      },
    },
    subtotal_cents: { type: SchemaType.INTEGER },
    tax_cents: { type: SchemaType.INTEGER },
    tip_cents: { type: SchemaType.INTEGER },
    total_cents: { type: SchemaType.INTEGER },
  },
  required: [
    'merchant',
    'date',
    'items',
    'subtotal_cents',
    'tax_cents',
    'tip_cents',
    'total_cents',
  ],
};

export type ExtractionErrorKind = 'api' | 'rate-limit' | 'timeout' | 'invalid-json' | 'schema';

export class ExtractionError extends Error {
  constructor(
    public readonly kind: ExtractionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export type TokenUsage = {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ExtractResult = {
  extraction: Extraction;
  // The raw parsed JSON exactly as the model returned it, persisted as
  // jsonb for debugging.
  raw: unknown;
  usage: TokenUsage | null;
};

// Minimal surface of the SDK model, injectable so tests never hit the API.
export type ReceiptModel = {
  generateContent(request: {
    contents: {
      role: string;
      parts: ({ text: string } | { inlineData: { data: string; mimeType: string } })[];
    }[];
  }): Promise<{
    response: {
      text(): string;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
  }>;
};

export function defaultReceiptModel(apiKey: string): ReceiptModel {
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: RECEIPT_MODEL_ID,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      // Draft extraction wants determinism, not creativity.
      temperature: 0,
    },
  });
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];
const DEFAULT_TIMEOUT_MS = 45_000;

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate limit|RESOURCE_EXHAUSTED|quota/i.test(message);
}

// Transient capacity errors ("model is currently experiencing high
// demand") deserve the same backoff as rate limits — observed live from
// gemini-3.5-flash during development.
function isOverloaded(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 503) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b503\b|UNAVAILABLE|overloaded|high demand/i.test(message);
}

// Pull the JSON object out of a model reply that may wrap it in a markdown
// fence or append trailing prose. With responseMimeType json this is
// usually the raw object already; the tolerance costs nothing.
export function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ExtractionError('invalid-json', 'Model reply contains no JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new ExtractionError(
      'invalid-json',
      `Model reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type ReceiptImageInput = {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
};

export async function extractReceipt(
  // One or more images of a SINGLE order/receipt (pages or app-order
  // screenshots). All are sent in one request and merged by the model, so
  // the free-tier quota cost stays one call regardless of image count.
  input: { images: ReceiptImageInput[] },
  options?: {
    model?: ReceiptModel;
    timeoutMs?: number;
    // Injectable for tests so retry backoff does not actually sleep.
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ExtractResult> {
  if (input.images.length === 0) {
    throw new ExtractionError('api', 'At least one image is required');
  }
  const apiKey = process.env.GEMINI_API_KEY;
  const model =
    options?.model ??
    (() => {
      if (!apiKey) throw new ExtractionError('api', 'GEMINI_API_KEY is not set');
      return defaultReceiptModel(apiKey);
    })();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const request = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: EXTRACTION_PROMPT },
          ...input.images.map((img) => ({
            inlineData: { data: img.imageBase64, mimeType: img.mimeType },
          })),
        ],
      },
    ],
  };

  // One initial attempt plus one retry per backoff delay; rate limits and
  // timeouts retry, everything else fails fast (a schema-invalid response
  // will not get better by resending the same image).
  let lastError: ExtractionError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let result;
    try {
      result = await Promise.race([
        model.generateContent(request),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new ExtractionError('timeout', `Extraction timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      if (err instanceof ExtractionError && err.kind === 'timeout') {
        lastError = err;
        continue;
      }
      if (isRateLimit(err)) {
        lastError = new ExtractionError('rate-limit', 'Gemini rate limit (429)');
        continue;
      }
      if (isOverloaded(err)) {
        lastError = new ExtractionError('api', 'Gemini temporarily overloaded (503)');
        continue;
      }
      throw new ExtractionError(
        'api',
        `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const raw = parseModelJson(result.response.text());
    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success) {
      const reason = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ExtractionError('schema', `Extraction failed validation: ${reason}`);
    }

    const meta = result.response.usageMetadata;
    return {
      extraction: parsed.data,
      raw,
      usage: meta
        ? {
            promptTokens: meta.promptTokenCount ?? 0,
            outputTokens: meta.candidatesTokenCount ?? 0,
            totalTokens: meta.totalTokenCount ?? 0,
          }
        : null,
    };
  }

  throw lastError ?? new ExtractionError('api', 'Extraction failed');
}
