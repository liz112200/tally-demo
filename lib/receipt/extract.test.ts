import { describe, it, expect, vi } from 'vitest';
import {
  extractReceipt,
  parseModelJson,
  ExtractionError,
  type ReceiptModel,
} from './extract';

const VALID = {
  merchant: 'RIVERTON ASIAN MARKET',
  date: '2026-07-08',
  items: [
    { description: 'Honey Butter Chips', quantity: 1, amount_cents: 499 },
    { description: 'Sweet Rice Cake', quantity: 1, amount_cents: 299 },
  ],
  subtotal_cents: 798,
  tax_cents: 26,
  tip_cents: 0,
  total_cents: 824,
};

const INPUT = {
  images: [{ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' as const }],
};

function modelReturning(texts: (string | Error)[]): {
  model: ReceiptModel;
  calls: () => number;
} {
  let call = 0;
  return {
    model: {
      generateContent: vi.fn(async () => {
        const next = texts[Math.min(call, texts.length - 1)];
        call += 1;
        if (next instanceof Error) throw next;
        return {
          response: {
            text: () => next,
            usageMetadata: {
              promptTokenCount: 1290,
              candidatesTokenCount: 180,
              totalTokenCount: 1470,
            },
          },
        };
      }),
    },
    calls: () => call,
  };
}

const noSleep = async () => {};

describe('parseModelJson', () => {
  it('parses a bare JSON object', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a markdown fence', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON with trailing prose', () => {
    expect(parseModelJson('{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('throws invalid-json when no object is present', () => {
    expect(() => parseModelJson('sorry, I cannot')).toThrowError(ExtractionError);
    try {
      parseModelJson('sorry');
    } catch (e) {
      expect((e as ExtractionError).kind).toBe('invalid-json');
    }
  });

  it('throws invalid-json on a truncated object', () => {
    try {
      parseModelJson('{"a": [1, 2}');
      expect.unreachable();
    } catch (e) {
      expect((e as ExtractionError).kind).toBe('invalid-json');
    }
  });
});

describe('extractReceipt', () => {
  it('returns validated extraction, raw JSON, and token usage', async () => {
    const { model } = modelReturning([JSON.stringify(VALID)]);
    const result = await extractReceipt(INPUT, { model, sleep: noSleep });
    expect(result.extraction).toEqual(VALID);
    expect(result.raw).toEqual(VALID);
    expect(result.usage).toEqual({
      promptTokens: 1290,
      outputTokens: 180,
      totalTokens: 1470,
    });
  });

  it('defaults a missing item quantity to 1', async () => {
    const noQty = {
      ...VALID,
      items: [{ description: 'Chips', amount_cents: 499 }],
    };
    const { model } = modelReturning([JSON.stringify(noQty)]);
    const result = await extractReceipt(INPUT, { model, sleep: noSleep });
    expect(result.extraction.items[0].quantity).toBe(1);
  });

  it('accepts a fenced response', async () => {
    const { model } = modelReturning(['```json\n' + JSON.stringify(VALID) + '\n```']);
    const result = await extractReceipt(INPUT, { model, sleep: noSleep });
    expect(result.extraction.merchant).toBe('RIVERTON ASIAN MARKET');
  });

  it('sends every image in one request (one call, N image parts)', async () => {
    let seenParts: unknown[] = [];
    const model: ReceiptModel = {
      generateContent: vi.fn(async (req) => {
        seenParts = req.contents[0].parts;
        return { response: { text: () => JSON.stringify(VALID) } };
      }),
    };
    await extractReceipt(
      {
        images: [
          { imageBase64: 'aQ==', mimeType: 'image/jpeg' },
          { imageBase64: 'aR==', mimeType: 'image/png' },
          { imageBase64: 'aS==', mimeType: 'image/jpeg' },
        ],
      },
      { model, sleep: noSleep },
    );
    expect(model.generateContent).toHaveBeenCalledTimes(1);
    const imageParts = seenParts.filter((p) => 'inlineData' in (p as object));
    expect(imageParts).toHaveLength(3);
  });

  it('rejects an empty image list', async () => {
    const { model } = modelReturning([JSON.stringify(VALID)]);
    await expect(
      extractReceipt({ images: [] }, { model, sleep: noSleep }),
    ).rejects.toThrow(ExtractionError);
  });

  it('fails fast with a schema error naming the missing field', async () => {
    const missing = { ...VALID } as Record<string, unknown>;
    delete missing.total_cents;
    const { model, calls } = modelReturning([JSON.stringify(missing)]);
    await expect(
      extractReceipt(INPUT, { model, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('total_cents') });
    expect(calls()).toBe(1); // resending the same image cannot fix schema errors
  });

  it('fails fast on non-cents floats', async () => {
    const floaty = { ...VALID, total_cents: 8.24 };
    const { model } = modelReturning([JSON.stringify(floaty)]);
    await expect(
      extractReceipt(INPUT, { model, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'schema' });
  });

  it('fails fast on malformed JSON', async () => {
    const { model, calls } = modelReturning(['not json at all']);
    await expect(
      extractReceipt(INPUT, { model, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'invalid-json' });
    expect(calls()).toBe(1);
  });

  it('retries 429s with 2s/4s/8s backoff and then succeeds', async () => {
    const rateLimited = Object.assign(new Error('429 Too Many Requests'), {
      status: 429,
    });
    const { model, calls } = modelReturning([
      rateLimited,
      rateLimited,
      JSON.stringify(VALID),
    ]);
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const result = await extractReceipt(INPUT, { model, sleep });
    expect(result.extraction.total_cents).toBe(824);
    expect(calls()).toBe(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it('gives up after exhausting the backoff schedule', async () => {
    const rateLimited = Object.assign(new Error('rate limit'), { status: 429 });
    const { model, calls } = modelReturning([rateLimited]);
    const delays: number[] = [];
    await expect(
      extractReceipt(INPUT, {
        model,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(calls()).toBe(4); // initial + one per backoff step
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  it('retries a timeout and succeeds on the next attempt', async () => {
    let call = 0;
    const model: ReceiptModel = {
      generateContent: async () => {
        call += 1;
        if (call === 1) {
          // Hang past the timeout; the race rejects first.
          return new Promise(() => {}) as never;
        }
        return {
          response: { text: () => JSON.stringify(VALID) },
        };
      },
    };
    const result = await extractReceipt(INPUT, {
      model,
      sleep: noSleep,
      timeoutMs: 20,
    });
    expect(result.extraction.total_cents).toBe(824);
    expect(result.usage).toBeNull();
    expect(call).toBe(2);
  });

  it('wraps other SDK failures as api errors without retrying', async () => {
    const { model, calls } = modelReturning([new Error('invalid api key')]);
    await expect(
      extractReceipt(INPUT, { model, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'api' });
    expect(calls()).toBe(1);
  });
});

describe('extractReceipt 503 handling', () => {
  it('retries a 503 overload and succeeds', async () => {
    const overloaded = Object.assign(
      new Error('[503 Service Unavailable] This model is currently experiencing high demand.'),
      { status: 503 },
    );
    let call = 0;
    const model: ReceiptModel = {
      generateContent: async () => {
        call += 1;
        if (call === 1) throw overloaded;
        return { response: { text: () => JSON.stringify(VALID) } };
      },
    };
    const delays: number[] = [];
    const result = await extractReceipt(INPUT, {
      model,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.extraction.merchant).toBe('RIVERTON ASIAN MARKET');
    expect(delays).toEqual([2000]);
  });
});
