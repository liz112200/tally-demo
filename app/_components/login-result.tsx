'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { MessageLine, type Message } from './action-message';

// One result slot per login on /accounts. Every action on a login (Sync now,
// Reconnect, Choose shared accounts, Check, Pause, Resume, Retry, Remove)
// reports here, and the latest result replaces the one before. The slot sits
// on the card itself, so it outlives the button that ran the action: a
// Reconnect from the "needs reconnecting" callout unmounts that callout when
// it succeeds, and its message must not go with it. And an older result
// ("Nothing synced: …") cannot keep asserting a state a later action fixed.
export type LoginResult = Message;

type Slot = { result: LoginResult; report: (result: LoginResult) => void };

const LoginResultContext = createContext<Slot | null>(null);

export function LoginResultProvider({ children }: { children: ReactNode }) {
  const [result, report] = useState<LoginResult>(null);
  return <LoginResultContext.Provider value={{ result, report }}>{children}</LoginResultContext.Provider>;
}

// For an action on a login. Throws outside a LoginResultProvider, so a
// control placed where its result would have nowhere to go fails loudly
// rather than reporting into nothing.
export function useLoginResult(): (result: LoginResult) => void {
  const slot = useContext(LoginResultContext);
  if (!slot) throw new Error('useLoginResult must be used inside a LoginResultProvider');
  return slot.report;
}

export function LoginResultLine() {
  const slot = useContext(LoginResultContext);
  if (!slot?.result) return null;
  return (
    <div className="border-b px-4 py-2">
      <MessageLine message={slot.result} />
    </div>
  );
}
