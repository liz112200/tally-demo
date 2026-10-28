// The Link flow in progress, kept for the OAuth redirect page
// (/accounts/oauth). When an OAuth institution cannot use a popup it sends
// the browser to the redirect URI, and Link must be reopened there with the
// same link token. The link token is short-lived and grants nothing on its
// own; no access token is ever stored in the browser. Session storage, so it
// stays with the tab, and every access is guarded: it may be unavailable.
export type LinkFlow =
  | { mode: 'new' }
  | { mode: 'update'; connectionId: string; accountSelection: boolean };

const KEY = 'tally.plaid-link-flow';

export function rememberLinkFlow(linkToken: string, flow: LinkFlow): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ linkToken, flow }));
  } catch {
    // Without storage the popup flow still works; only a redirect cannot resume.
  }
}

export function recallLinkFlow(): { linkToken: string; flow: LinkFlow } | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { linkToken?: unknown; flow?: { mode?: unknown; connectionId?: unknown; accountSelection?: unknown } };
    if (typeof value.linkToken !== 'string' || !value.flow) return null;
    if (value.flow.mode === 'new') return { linkToken: value.linkToken, flow: { mode: 'new' } };
    if (value.flow.mode === 'update' && typeof value.flow.connectionId === 'string') {
      return {
        linkToken: value.linkToken,
        flow: { mode: 'update', connectionId: value.flow.connectionId, accountSelection: value.flow.accountSelection === true },
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function forgetLinkFlow(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
