import { getDebtShares } from '@/db/queries';
import { computeBidirectionalBalances } from '@/lib/balances';
import { isDemoMode } from '@/lib/demo-mode';
import { redirect } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';
import { loadBoard, needsYouFacts } from '@/app/_lib/board';
import { NeedsYouBand } from '@/app/_components/needs-you-band';
import { needsYouItems } from '@/lib/needs-you';
import { formatUSD, toCents } from '@/lib/money';
import { PassbookRegister } from '@/app/_components/account-board';

export const dynamic = 'force-dynamic';

// The home page: the accounts board (2026-11-05), with the Needs you band
// above it. Every account as a card, where it is in its statement cycle and
// what is true about it, each opening its own page. Bank logins (linking,
// Reconnect, Set up) are on their own page, linked here.
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  // Expenses lived here until then. The board takes no parameters, so a link
  // carrying any (?tx=, ?q=, ?tab=, ?demo=) was one to Expenses: it goes there.
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  if ([...query.keys()].length > 0) redirect(`/expenses?${query}`);
  const demo = isDemoMode();
  const [board, debtShares] = await Promise.all([loadBoard(), getDebtShares()]);
  const balances = computeBidirectionalBalances(debtShares.map((s) => ({
    ...s, amountCents: toCents(s.amountCents), allocatedCents: toCents(s.allocatedCents),
  })));
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const items = needsYouItems(needsYouFacts(board), { day, money: (n) => formatUSD(toCents(n)) });
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
      <NeedsYouBand items={items} />
      <div className="passbook-spread" data-long-register={board.cards.length + board.unmapped.length > 4 || undefined}>
        <section className="passbook-cover">
          <div className="passbook-seal" aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 7.5}deg)` }} />)}
          </div>
          <time>{new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</time>
          <h1>Account<br /><em>passbook.</em></h1>
          <div className="passbook-imprint"><span>{demo ? 'Riley' : user.displayName}</span><span>{board.cards.length} {board.cards.length === 1 ? 'account' : 'accounts'}</span></div>
        </section>
        <section className="passbook-register" aria-labelledby="register-title">
          <div className="register-heading">
            <h2 id="register-title">Account register</h2>
            <a href="/accounts/logins">Bank logins →</a>
          </div>
          <PassbookRegister cards={board.cards} unmapped={board.unmapped} />
        </section>
        <dl className="ledger-metrics" aria-label="Outstanding balances">
          <div><dt>Owed to you</dt><dd>{formatUSD(toCents(balances.reduce((sum, b) => sum + Math.max(0, b.netCents), 0)))}</dd></div>
          <div><dt>You owe</dt><dd>{formatUSD(toCents(balances.reduce((sum, b) => sum + Math.max(0, -b.netCents), 0)))}</dd></div>
          <div><dt>Shared transactions</dt><dd>{Object.keys(board.view.splitsByTransaction).length}</dd></div>
        </dl>
      </div>
    </main>
  );
}
