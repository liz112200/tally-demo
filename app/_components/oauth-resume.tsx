'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  usePlaidLink,
  type PlaidLinkOnExit,
  type PlaidLinkOnSuccess,
  type PlaidLinkOnSuccessMetadata,
} from 'react-plaid-link';
import { finishLinkFlow, SandboxLinkAnyway } from './link-bank-button';
import { MessageLine, resultMessage, type Message } from './action-message';
import { forgetLinkFlow, recallLinkFlow, type LinkFlow } from './link-flow';

type Stage =
  | { kind: 'loading' }
  | { kind: 'nothing' }
  | { kind: 'resuming'; linkToken: string; flow: LinkFlow; redirectUri: string }
  | { kind: 'done'; flow: LinkFlow; message: Message };

// Reopens Link after an OAuth redirect. The stored flow and the full URL Plaid
// returned to are read in the browser only (session storage, the address),
// so the server render shows a loading line.
export function OAuthResume({ sandboxOverride }: { sandboxOverride: boolean }) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [completing, startCompleting] = useTransition();
  const [retry, setRetry] = useState<{ flow: LinkFlow; publicToken: string | null; metadata: PlaidLinkOnSuccessMetadata } | null>(null);

  useEffect(() => {
    const stored = recallLinkFlow();
    // Read once on arrival; storage and the address are browser-only.
    setStage(stored ? { kind: 'resuming', ...stored, redirectUri: window.location.href } : { kind: 'nothing' });
  }, []);

  const finish = useCallback((flow: LinkFlow, publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata, linkAnyway: boolean) => {
    startCompleting(async () => {
      const result = await finishLinkFlow(flow, publicToken, metadata, linkAnyway);
      setRetry('error' in result && result.overridable ? { flow, publicToken, metadata } : null);
      setStage({ kind: 'done', flow, message: resultMessage(result) });
    });
  }, []);

  const flow = stage.kind === 'resuming' ? stage.flow : null;
  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      forgetLinkFlow();
      if (flow) finish(flow, publicToken, metadata, false);
    },
    [flow, finish],
  );
  const onExit = useCallback<PlaidLinkOnExit>(
    (error) => {
      forgetLinkFlow();
      if (flow) {
        setStage({
          kind: 'done',
          flow,
          message: error ? { kind: 'error', text: error.display_message ?? error.error_message } : null,
        });
      }
    },
    [flow],
  );

  const { open, ready } = usePlaidLink({
    token: stage.kind === 'resuming' ? stage.linkToken : null,
    receivedRedirectUri: stage.kind === 'resuming' ? stage.redirectUri : undefined,
    onSuccess,
    onExit,
  });

  useEffect(() => {
    if (stage.kind === 'resuming' && ready) open();
  }, [stage.kind, ready, open]);

  const back = (
    <Link href="/accounts" className="text-sm underline underline-offset-2">
      Back to Accounts
    </Link>
  );

  switch (stage.kind) {
    case 'loading':
    case 'resuming':
      return <p className="mt-2 text-sm text-muted-foreground">{completing ? 'Saving and syncing…' : 'Returning to the bank sign-in…'}</p>;
    case 'nothing':
      return (
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>This page continues a bank sign-in started from Accounts in this tab, and there is none to continue.</p>
          {back}
        </div>
      );
    case 'done':
      return (
        <div className="mt-2 space-y-2 text-sm">
          {completing ? (
            <p className="text-muted-foreground">Saving and syncing…</p>
          ) : stage.message ? (
            <MessageLine message={stage.message} />
          ) : (
            <p>{stage.flow.mode === 'update' ? 'Reconnected.' : 'Linked.'}</p>
          )}
          <SandboxLinkAnyway
            allowed={sandboxOverride}
            onClick={retry ? () => finish(retry.flow, retry.publicToken, retry.metadata, true) : null}
          />
          {back}
        </div>
      );
  }
}
