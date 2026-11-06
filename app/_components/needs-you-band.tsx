import { Check } from 'lucide-react';
import { KIND_LABEL, type NeedsYouItem, type NeedsYouKind } from '@/lib/needs-you';

const GLYPH: Record<NeedsYouKind, string> = {
  question: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  problem: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  trust: 'bg-blue-500/15 text-blue-800 dark:text-blue-300',
  task: 'bg-muted text-foreground',
};

// The Needs you band above the accounts board (2026-11-05): what Tally has
// noticed about its own state that is still open, one line each, subject
// first, with the action that resolves it. Only resolving it removes a line.
// Empty, it is one line: All clear.
export function NeedsYouBand({ items }: { items: NeedsYouItem[] }) {
  if (items.length === 0) {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-xl border border-emerald-600/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-900 dark:text-emerald-200">
        <Check aria-hidden className="size-4 shrink-0" />
        <span>
          <span className="font-semibold">All clear.</span> Nothing is waiting on you.
        </span>
      </div>
    );
  }
  return (
    <section aria-labelledby="needs-you" className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pb-2 pt-3.5 sm:px-5">
        <h2 id="needs-you" className="whitespace-nowrap text-[15px] font-semibold">
          Needs you · {items.length}
        </h2>
        <span className="text-xs text-muted-foreground">What Tally has noticed and can tell is still open</span>
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5 sm:px-5">
            <span
              role="img"
              aria-label={KIND_LABEL[item.kind].label}
              title={KIND_LABEL[item.kind].label}
              className={`inline-flex size-[26px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${GLYPH[item.kind]}`}
            >
              {KIND_LABEL[item.kind].glyph}
            </span>
            <span className="min-w-0 flex-1 basis-60 text-sm leading-snug">
              <span className="font-semibold">{item.subject}:</span> {item.text}
            </span>
            <a
              href={item.href}
              className="inline-flex min-h-9 items-center rounded-lg border px-3.5 text-[13px] font-medium hover:bg-muted"
            >
              {item.action}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
