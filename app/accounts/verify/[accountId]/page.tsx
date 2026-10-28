import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/index';
import { bankAccounts, bankConnections } from '@/db/schema';
import { requireUser } from '@/app/_lib/session';
import { isDemoMode } from '@/lib/demo-mode';
import { VerifyForm } from '@/app/_components/verify-form';

export const metadata = { title: 'Verify an account · tally' };
export const dynamic = 'force-dynamic';

// Sign verification against a statement (REAL-ACCOUNTS.md): until it passes,
// the account's synced rows count nowhere.
export default async function VerifyAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  await requireUser();
  if (isDemoMode()) notFound();
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(accountId)) notFound();
  const [account] = await db
    .select({
      name: bankAccounts.name,
      mask: bankAccounts.mask,
      type: bankAccounts.type,
      verifiedAt: bankAccounts.verifiedAt,
      institution: bankConnections.institutionName,
    })
    .from(bankAccounts)
    .innerJoin(bankConnections, eq(bankConnections.id, bankAccounts.connectionId))
    .where(eq(bankAccounts.id, accountId));
  if (!account) notFound();
  const label = `${account.institution ?? ''} ${account.name}${account.mask ? ` ••${account.mask}` : ''}`.trim();
  const card = account.type === 'credit';
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Check {label} against a statement</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        {account.verifiedAt
          ? 'This account is verified; checking again replaces the record.'
          : 'Until this passes, its synced rows are not counted or splittable. Use your most recent closed statement.'}{' '}
        Statements group rows by posted date, so that is the date compared.
      </p>
      <VerifyForm
        accountId={accountId}
        chargesLabel={card ? 'Purchases + fees + interest' : 'Withdrawals'}
        creditsLabel={card ? 'Payments + credits' : 'Deposits'}
      />
    </main>
  );
}
