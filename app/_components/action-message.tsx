'use client';

import { Check } from 'lucide-react';
import type { LinkResultState } from '@/app/_actions/bank';

// `details`: lines listed under the message, one per account synced.
export type Message = { kind: 'error' | 'warning' | 'success'; text: string; details?: string[] } | null;

// What an action did. Success is said as plainly as failure, in the page's
// own text colour: amber and red stay for what needs the owner.
export function MessageLine({ message }: { message: Message }) {
  if (!message) return null;
  if (message.details && message.details.length > 0) {
    const { details, ...head } = message;
    return (
      <div className="space-y-0.5">
        <MessageLine message={head} />
        <ul className="space-y-0.5 pl-[1.125rem] text-xs text-muted-foreground">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (message.kind === 'success') {
    return (
      <p role="status" className="flex items-start gap-1 text-xs text-foreground">
        <Check aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{message.text}</span>
      </p>
    );
  }
  return (
    <p
      role={message.kind === 'error' ? 'alert' : 'status'}
      className={
        message.kind === 'error'
          ? 'text-xs text-destructive'
          : 'text-xs text-amber-700 dark:text-amber-400'
      }
    >
      {message.text}
    </p>
  );
}

// The line a finished action shows: its warning when it only partly worked,
// otherwise what it did.
export function resultMessage(result: LinkResultState): Message {
  if ('error' in result) return { kind: 'error', text: result.error };
  if (result.warning) return { kind: 'warning', text: result.warning, details: result.details };
  return result.message ? { kind: 'success', text: result.message, details: result.details } : null;
}

