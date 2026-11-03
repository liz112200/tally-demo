// Where production and the demo must never cross (DEMO-SYNC.md): which bank
// provider a deployment builds, and how a stored token is opened. The demo
// builds only the synthetic provider and opens only synthetic connections;
// everywhere else builds only Plaid and opens only Plaid connections. Pure;
// app/_actions/bank.ts passes in whether this is demo mode.
import { AccessToken } from './access-token';
import type { BankProvider, BankProviderName } from './provider';
import { syntheticToken } from './synthetic/provider';

export function chooseProvider(
  demo: boolean,
  make: { plaid: () => BankProvider; synthetic: () => BankProvider },
): BankProvider {
  return demo ? make.synthetic() : make.plaid();
}

// A Plaid token is unsealed with BANK_TOKEN_KEY (which the demo never holds);
// a synthetic one is its own fixed value, naming its login.
export function openStoredToken(
  demo: boolean,
  row: { provider: BankProviderName; providerItemId: string; accessTokenSealed: string },
  unsealPlaid: () => string,
): AccessToken {
  if (row.provider === 'synthetic') {
    if (!demo) throw new Error('A synthetic connection opens only in the demo.');
    if (row.accessTokenSealed !== syntheticToken(row.providerItemId)) {
      throw new Error('This synthetic connection does not hold its own token.');
    }
    return new AccessToken(row.accessTokenSealed);
  }
  if (demo) throw new Error('The demo opens no Plaid connection.');
  return new AccessToken(unsealPlaid());
}
