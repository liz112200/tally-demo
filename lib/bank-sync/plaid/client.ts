// A thin, typed client for the Plaid endpoints this app calls, over plain
// fetch rather than Plaid's SDK: every response is validated with Zod at the
// boundary, and JSON parsing is under our control so amounts never become
// floats (BANK-SYNC.md). Credentials travel in headers, never in the body.
//
// No Next, database, or process.env access; configuration is passed in.
import { z } from 'zod';

export const PLAID_ENVS = ['sandbox', 'production'] as const;
export type PlaidEnv = (typeof PLAID_ENVS)[number];

const BASE_URLS: Record<PlaidEnv, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

// The API version every response shape here was written against.
export const PLAID_API_VERSION = '2020-09-14';

const REQUEST_TIMEOUT_MS = 30_000;

export type PlaidConfig = {
  clientId: string;
  secret: string;
  env: PlaidEnv;
  // Where an OAuth institution sends the browser back when Link cannot use a
  // popup (mobile web views). Must match an allowed redirect URI in the Plaid
  // dashboard exactly, so it is passed through untouched; omitted when unset.
  redirectUri?: string;
  // Injected in tests.
  fetch?: typeof fetch;
};

// Read the Plaid configuration from an environment object. Throws with the
// names of whatever is missing; the values are never echoed.
export function plaidConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PlaidConfig {
  const missing = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Bank linking is not configured: ${missing.join(', ')} not set`);
  }
  const plaidEnv = env.PLAID_ENV as string;
  if (!(PLAID_ENVS as readonly string[]).includes(plaidEnv)) {
    throw new Error(`PLAID_ENV must be "sandbox" or "production"`);
  }
  const redirectUri = env.PLAID_REDIRECT_URI;
  if (redirectUri !== undefined && redirectUri !== '') {
    checkRedirectUri(redirectUri, plaidEnv as PlaidEnv);
  }
  return {
    clientId: env.PLAID_CLIENT_ID as string,
    secret: env.PLAID_SECRET as string,
    env: plaidEnv as PlaidEnv,
    ...(redirectUri ? { redirectUri } : {}),
  };
}

// Plaid accepts plain http only for localhost, and only in Sandbox; it also
// refuses fragments. Checked here so a bad value fails on startup with its
// name rather than as an opaque Link error.
function checkRedirectUri(value: string, env: PlaidEnv): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PLAID_REDIRECT_URI is not a URL');
  }
  const localhost = url.protocol === 'http:' && url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(localhost && env === 'sandbox')) {
    throw new Error('PLAID_REDIRECT_URI must be https (plain http is allowed only for localhost in Sandbox)');
  }
  if (url.hash !== '' || value.includes('#')) {
    throw new Error('PLAID_REDIRECT_URI must not contain a fragment');
  }
}

// JSON.parse that keeps every number as its source text: 12.345 arrives as
// "12.345", so money converts to integer mills by string parsing and never
// passes through a float. Relies on the reviver's third argument (JSON.parse
// source text access, verified on Node 24 locally and in a Vercel function);
// a runtime without it throws here rather than silently yielding floats.
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') {
      throw new Error('JSON.parse source text access is unavailable in this runtime');
    }
    return context.source;
  });
}

// Plaid's error envelope (HTTP 4xx/5xx with a JSON body).
const plaidErrorSchema = z.object({
  error_type: z.string(),
  error_code: z.string(),
  error_message: z.string(),
  display_message: z.string().nullable().optional(),
  request_id: z.string().optional(),
});

export class PlaidApiError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly errorCode: string;
  // Plaid's user-facing text, when it provides one; safe to show.
  readonly displayMessage: string | null;
  readonly requestId: string | null;

  constructor(
    status: number,
    body: { errorType: string; errorCode: string; message: string; displayMessage: string | null; requestId: string | null },
  ) {
    super(`Plaid ${body.errorType}/${body.errorCode}: ${body.message}`);
    this.name = 'PlaidApiError';
    this.status = status;
    this.errorType = body.errorType;
    this.errorCode = body.errorCode;
    this.displayMessage = body.displayMessage;
    this.requestId = body.requestId;
  }
}

export type PlaidClient = {
  post<S extends z.ZodType>(path: string, body: Record<string, unknown>, schema: S): Promise<z.infer<S>>;
};

export function createPlaidClient(config: PlaidConfig): PlaidClient {
  const doFetch = config.fetch ?? fetch;
  const baseUrl = BASE_URLS[config.env];

  return {
    async post(path, body, schema) {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': config.clientId,
          'PLAID-SECRET': config.secret,
          'Plaid-Version': PLAID_API_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = parseJsonExact(text);
      } catch {
        throw new Error(`Plaid ${path} returned non-JSON (HTTP ${res.status})`);
      }

      if (!res.ok) {
        const err = plaidErrorSchema.safeParse(json);
        if (!err.success) throw new Error(`Plaid ${path} failed with HTTP ${res.status}`);
        throw new PlaidApiError(res.status, {
          errorType: err.data.error_type,
          errorCode: err.data.error_code,
          message: err.data.error_message,
          displayMessage: err.data.display_message ?? null,
          requestId: err.data.request_id ?? null,
        });
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Plaid ${path} response did not match the expected shape at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
        );
      }
      return parsed.data;
    },
  };
}
