import { formatUSD, toCents } from '@/lib/money';
import type { AccountCard, CardChip } from '@/lib/account-card';
import { RelativeTime } from '@/app/_components/relative-time';

const CHIP: Record<CardChip['tone'], string> = {
  ok: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-800 dark:text-blue-300',
  quiet: 'border-border bg-muted text-muted-foreground',
};

export type BoardCard = AccountCard & {
  // When it last heard from its bank, or its last CSV upload.
  syncedAt: string | null;
  lastImport: string | null;
};

// The accounts board (2026-11-05): one card per ledger account, name first and
// largest, a bar for where it is in its cycle, the close with the statement
// count beside it (never only in a hover), this cycle's figures, and chips.
// A grid on a laptop, one column on a phone; each card's parts sit on rows
// shared across the row of cards, so a name that wraps moves its neighbours'
// rows with it rather than leaving them misaligned.
export function AccountBoard({ cards, unmapped }: { cards: BoardCard[]; unmapped: { id: string; name: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(255px,1fr))] gap-3.5">
      {cards.map((c) => (
        <a
          key={c.id}
          href={`/accounts/${c.id}`}
          className="row-span-7 grid grid-rows-subgrid gap-y-2 rounded-2xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <div>
            <div className="text-xl font-bold leading-tight tracking-tight">{c.name}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{c.kind}</div>
          </div>
          <div aria-hidden className="h-2 self-center overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground" style={{ width: `${c.cycle?.progress ?? 0}%` }} />
          </div>
          <div title={c.cycle?.reason}>
            <div className="text-sm font-semibold">{c.cycle ? c.cycle.range : 'No statement recorded'}</div>
            <div className="mt-0.5 flex flex-wrap justify-between gap-x-2.5 text-[13px] text-muted-foreground">
              <span className="whitespace-nowrap">{c.cycle ? c.cycle.count : 'record one to see the cycle'}</span>
              {c.cycle && <span className="whitespace-nowrap">{c.cycle.left}</span>}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 self-start text-[13px]">
            {c.figures.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="text-right font-medium tabular-nums">{formatUSD(toCents(f.mills))}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap content-start gap-1.5">
            {c.chips.map((chip) => (
              <span key={chip.label} className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP[chip.tone]}`}>
                {chip.label}
              </span>
            ))}
          </div>
          <div />
          <div className="border-t pt-2.5 text-xs text-muted-foreground">
            {c.syncedAt ? <RelativeTime iso={c.syncedAt} prefix="synced " /> : c.lastImport ? `last CSV import ${c.lastImport}` : 'no rows yet'}
          </div>
        </a>
      ))}
      {unmapped.map((u) => (
        <a
          key={u.id}
          href="/accounts/logins"
          className="flex flex-col justify-center gap-1 rounded-2xl border border-dashed p-4 text-sm text-muted-foreground hover:border-foreground/30"
        >
          <span className="font-semibold text-foreground">{u.name}</span>
          Linked, not set up yet: choose where it syncs into.
        </a>
      ))}
    </div>
  );
}
