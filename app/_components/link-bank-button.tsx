'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  usePlaidLink,
  type PlaidLinkOnExit,
  type PlaidLinkOnSuccess,
  type PlaidLinkOnSuccessMetadata,
} from 'react-plaid-link';
import { Landmark, RefreshCw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  completeLink,
  completeUpdate,
  createLinkToken,
  createUpdateLinkToken,
  retryLoadAccounts,
  type LinkResultState,
  type LinkTokenState,
} from '@/app/_actions/bank';
import { rememberLinkFlow, forgetLinkFlow, type LinkFlow } from './link-flow';
import { useLoginResult } from './login-result';
import { MessageLine, resultMessage, type Message } from './action-message';

// What a Link success hands the server, for either flow. New logins send the
// public token (exchanged there; the browser never sees an access token) and
// the institution Link reports; update mode sends nothing, since its access
// token does not change.
export async function finishLinkFlow(
  flow: LinkFlow,
  publicToken: string | null,
  metadata: PlaidLinkOnSuccessMetadata,
  linkAnyway = false,
): Promise<LinkResultState> {
  if (flow.mode === 'update') return completeUpdate(flow.connectionId, flow.accountSelection);
  if (!publicToken) return { error: 'Link finished without a public token.' };
  return completeLink(publicToken, metadata.institution?.institution_id ?? null, linkAnyway);
}

// Opens Plaid Link for one flow. A fresh link token is fetched on each start
// (they expire, and an abandoned one is never reused) and remembered for the
// OAuth redirect page (link-flow.ts); Link opens as soon as its script is
// ready.
// `report`, when given, receives every result instead of the hook's own
// message state: a login's actions report to its result slot.
function useLinkFlow(
  flow: LinkFlow,
  fetchToken: () => Promise<LinkTokenState>,
  report?: (message: Message) => void,
) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [ownMessage, setOwnMessage] = useState<Message>(null);
  const setMessage = report ?? setOwnMessage;
  const message = report ? null : ownMessage;
  const [fetching, startFetching] = useTransition();
  const [completing, startCompleting] = useTransition();
  const [retry, setRetry] = useState<{ publicToken: string | null; metadata: PlaidLinkOnSuccessMetadata } | null>(null);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      setLinkToken(null);
      forgetLinkFlow();
      startCompleting(async () => {
        const result = await finishLinkFlow(flow, publicToken, metadata);
        setMessage(resultMessage(result));
        // Kept only when the server says the refusal can be overridden,
        // which it does only in Sandbox.
        setRetry('error' in result && result.overridable ? { publicToken, metadata } : null);
      });
    },
    [flow],
  );

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    setLinkToken(null);
    forgetLinkFlow();
    if (error) {
      setMessage({ kind: 'error', text: error.display_message ?? error.error_message });
    }
  }, []);

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess, onExit });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  function linkAnyway() {
    if (!retry) return;
    const { publicToken, metadata } = retry;
    setRetry(null);
    setMessage(null);
    startCompleting(async () => {
      setMessage(resultMessage(await finishLinkFlow(flow, publicToken, metadata, true)));
    });
  }

  function start() {
    setRetry(null);
    setMessage(null);
    startFetching(async () => {
      const result = await fetchToken();
      if ('error' in result) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      rememberLinkFlow(result.linkToken, flow);
      setLinkToken(result.linkToken);
    });
  }

  return {
    start,
    message,
    fetching,
    completing,
    busy: fetching || completing || linkToken !== null,
    linkAnyway: retry ? linkAnyway : null,
  };
}

const NEW_FLOW: LinkFlow = { mode: 'new' };

// Opens Plaid Link for a new bank login.
// Opens Plaid Link for a new bank login, after a confirmation that lists
// the logins already linked and, in production, what the link costs: one of
// the Trial's Items, for good. With none left, linking is not offered.
// `sandboxOverride` comes from the server page (duplicateOverrideAllowed);
// without it the duplicate guard's override never renders.
export function LinkBankButton({
  sandboxOverride,
  linkedInstitutions,
  itemsLeft,
}: {
  sandboxOverride: boolean;
  // One line per institution already linked (accounts-view.ts institutionLine).
  linkedInstitutions: string[];
  // Null in Sandbox, where Items are free.
  itemsLeft: number | null;
}) {
  const { start, message, completing, busy, linkAnyway } = useLinkFlow(NEW_FLOW, createLinkToken);
  const [open, setOpen] = useState(false);
  const exhausted = itemsLeft !== null && itemsLeft <= 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger
          render={
            <Button disabled={busy}>
              <Landmark data-icon="inline-start" />
              {completing ? 'Saving…' : busy ? 'Opening…' : 'Link a bank'}
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Link a new bank login?</AlertDialogTitle>
            <AlertDialogDescription render={<div className="space-y-2" />}>
              {linkedInstitutions.length === 0 ? (
                <p>No bank is linked yet.</p>
              ) : (
                <div>
                  <p>Already linked:</p>
                  <ul className="mt-0.5 list-disc pl-5">
                    {linkedInstitutions.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p>A login that stopped working is fixed with Reconnect on it, not by linking it again.</p>
              <p className="font-medium text-foreground">
                {itemsLeft === null
                  ? 'Sandbox: Items are free here.'
                  : exhausted
                    ? "No Items are left on Plaid's Trial. Linking another would move the account onto pay-as-you-go for good, so it is not offered here."
                    : `This uses 1 of the ${itemsLeft} Items left on Plaid's Trial, for good, even if the login is removed later.`}
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={exhausted}
              onClick={() => {
                setOpen(false);
                start();
              }}
            >
              Continue to the bank
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <MessageLine message={message} />
      <SandboxLinkAnyway allowed={sandboxOverride} onClick={linkAnyway} />
    </div>
  );
}

// The duplicate guard's override. Two conditions to render, both from the
// server's Plaid environment: the page says this is Sandbox (`allowed`), and
// the refusal carried `overridable`, which the action sets only in Sandbox.
// The action checks the environment a third time before honouring it.
export function SandboxLinkAnyway({ allowed, onClick }: { allowed: boolean; onClick: (() => void) | null }) {
  if (!allowed || !onClick) return null;
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      Link anyway (Sandbox only)
    </Button>
  );
}

// Opens Link's update mode on an existing login: Reconnect, or Choose shared
// accounts with accountSelection. Never creates an Item.
export function ReconnectButton({
  connectionId,
  accountSelection = false,
  primary = false,
}: {
  connectionId: string;
  accountSelection?: boolean;
  primary?: boolean;
}) {
  const [flow] = useState<LinkFlow>(() => ({ mode: 'update', connectionId, accountSelection }));
  const fetchToken = useCallback(
    () => createUpdateLinkToken(connectionId, accountSelection),
    [connectionId, accountSelection],
  );
  const { start, completing, busy } = useLinkFlow(flow, fetchToken, useLoginResult());
  const label = accountSelection ? 'Choose shared accounts' : 'Reconnect';
  return (
    <Button variant={primary ? 'default' : 'outline'} size="sm" onClick={start} disabled={busy} className="self-start">
      <RefreshCw data-icon="inline-start" />
      {completing ? 'Syncing…' : busy ? 'Opening…' : label}
    </Button>
  );
}

// Shown on a connection whose accounts failed to load after linking. The
// Item and its token are already stored; this only re-asks for accounts.
export function RetryAccountsButton({ connectionId }: { connectionId: string }) {
  const report = useLoginResult();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          report(null);
          report(resultMessage(await retryLoadAccounts(connectionId)));
        })
      }
    >
      <RotateCw data-icon="inline-start" />
      {pending ? 'Loading…' : 'Retry'}
    </Button>
  );
}
