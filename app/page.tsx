import { redirect } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';
import { loadBoard, needsYouFacts } from '@/app/_lib/board';
import { NeedsYouBand } from '@/app/_components/needs-you-band';
import { needsYouItems } from '@/lib/needs-you';
import { formatUSD, toCents } from '@/lib/money';
import { AccountBoard } from '@/app/_components/account-board';

export const dynamic = 'force-dynamic';

// The home page: the accounts board (2026-11-05), with the Needs you band
// above it. Every account as a card, where it is in its statement cycle and
// what is true about it, each opening its own page. Bank logins (linking,
// Reconnect, Set up) are on their own page, linked here.
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  // Expenses lived here until then. The board takes no parameters, so a link
  // carrying any (?tx=, ?q=, ?tab=, ?demo=) was one to Expenses: it goes there.
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  if ([...query.keys()].length > 0) redirect(`/expenses?${query}`);
  const board = await loadBoard();
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const items = needsYouItems(needsYouFacts(board), { day, money: (n) => formatUSD(toCents(n)) });
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
      <NeedsYouBand items={items} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Accounts</h1>
        <a href="/accounts/logins" className="inline-flex min-h-9 items-center text-sm text-blue-700 hover:underline dark:text-blue-400">
          Bank logins{board.loginCount > 0 ? ` (${board.loginCount})` : ''} →
        </a>
      </div>
      {board.cards.length === 0 && board.unmapped.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
          No accounts yet. Import a CSV from Expenses, or link a bank on the Bank logins page.
        </p>
      ) : (
        <AccountBoard cards={board.cards} unmapped={board.unmapped} />
      )}
    </main>
  );
}
