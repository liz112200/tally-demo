'use client';

import { createContext, useCallback, useContext, useEffect, useState, useTransition, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { SOMETHING_WENT_WRONG, type ActionResult } from '@/lib/action-result';
import { MessageLine, type Message } from './action-message';

// The page's result line (ACTION-RESULTS.md): the latest action's result,
// pinned to the bottom of the viewport so it is seen wherever the action
// was clicked, replaced by the next result, and dismissable. It lives in
// app/template.tsx, which Next mounts afresh on every navigation, so the
// line belongs to one visit to one page: it sits above anything an action
// can unmount within the page (a dialog that closes, a row that
// disappears), and leaving the page discards it. A result that arrives
// after the owner has left is dropped with it. The root layout, which never
// unmounts, held it first, and a result from Expenses was seen on /people.
//
// /accounts opts out: each login there has its own result slot
// (login-result.tsx) and its controls never report here, so one result is
// never shown in two places; and since this line clears on navigation, a
// result from another page is never left beside them.

type Report = (message: Message) => void;

const PageResultContext = createContext<Report | null>(null);

export function PageResultProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<Message>(null);
  return (
    <PageResultContext.Provider value={setMessage}>
      {children}
      {message && (
        // Above the Expenses bulk-action bar (bottom-6), which it must not cover.
        <div className="fixed bottom-20 left-1/2 z-40 flex w-max max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border bg-card px-3 py-2 shadow-lg">
          <MessageLine message={message} />
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setMessage(null)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </PageResultContext.Provider>
  );
}

function toMessage(result: ActionResult): Message {
  if ('error' in result) return { kind: 'error', text: result.error };
  if (result.warning) return { kind: 'warning', text: result.warning, details: result.details };
  return result.message ? { kind: 'success', text: result.message, details: result.details } : null;
}

// Runs a Server Action and makes its result seen. Success (and a warning)
// goes to the page result line. An error goes there too, unless the caller
// shows it in place (`errorsInPlace`, for a dialog that stays open). A
// request that fails without an answer (a network failure, a bug past the
// action's own error handling) is reported as such: the action may or may
// not have run. Throws outside a PageResultProvider, so a control placed
// where its result could not be seen fails loudly.
export function useAction(options: { errorsInPlace?: boolean } = {}) {
  const report = useContext(PageResultContext);
  if (!report) throw new Error('useAction must be used inside a PageResultProvider');
  const [pending, startTransition] = useTransition();
  const { errorsInPlace = false } = options;
  const run = useCallback(
    (action: () => Promise<ActionResult>, after?: (result: ActionResult) => void) => {
      startTransition(async () => {
        let result: ActionResult;
        try {
          result = await action();
        } catch {
          result = { error: SOMETHING_WENT_WRONG };
        }
        if (!('error' in result) || !errorsInPlace) report(toMessage(result));
        after?.(result);
      });
    },
    [report, errorsInPlace],
  );
  return { run, pending };
}

// For a form built on useActionState: says a successful save's `message` on
// the page result line, once per submission (each result is a new object).
// Field errors stay in the form, where they are.
export function useReportSuccess(state: { ok?: boolean; message?: string }) {
  const report = useContext(PageResultContext);
  if (!report) throw new Error('useReportSuccess must be used inside a PageResultProvider');
  useEffect(() => {
    if (state.ok && state.message) report({ kind: 'success', text: state.message });
  }, [state, report]);
}
