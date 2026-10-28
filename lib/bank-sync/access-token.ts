// An access token as an opaque value. The plaintext is full read access to a
// bank login, so it is held privately and reachable only through reveal(),
// which is called in exactly two places: sealing it for storage
// (app/_actions/bank.ts) and building a Plaid request body
// (lib/bank-sync/plaid/provider.ts).
//
// Every other way out fails loudly instead of leaking: toJSON throws, which
// stops both JSON.stringify and React's Flight serializer (the encoder for
// Server Action results and Client Component props; verified against the
// copy Next 16 bundles), and string conversion or console inspection prints
// a placeholder. Types alone cannot promise this — a wider
// object assigned to a narrower type still serializes — so the guarantee is
// carried by the runtime value.
import { inspect } from 'node:util';

const PLACEHOLDER = 'AccessToken([redacted])';

export class AccessToken {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new Error('Empty access token');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): never {
    throw new Error('An access token must never be serialized');
  }

  toString(): string {
    return PLACEHOLDER;
  }

  [inspect.custom](): string {
    return PLACEHOLDER;
  }
}
