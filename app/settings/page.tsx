import { Suspense } from 'react';
import { getAllRules, getCategories } from '@/db/queries';
import { RulesManager, ApplyRulesButton } from '@/app/_components/rules-manager';
import { CategoriesManager } from '@/app/_components/categories-manager';
import { BankCategories } from '@/app/_components/bank-categories';
import { bankCategoryRows } from '@/db/bank-categories';
import { activeSessions, getUserPasskeys } from '@/db/auth';
import { deviceLabel } from '@/lib/auth/device-label';
import { passkeyWhere } from '@/lib/auth/passkey-provider';
import { isDemoMode } from '@/lib/demo-mode';
import { requireUser } from '@/app/_lib/session';
import { AddDeviceButton, RevokeSessionButton } from '@/app/_components/devices';

export const metadata = { title: 'Settings · tally' };
export const dynamic = 'force-dynamic';

function formatWhen(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

// Settings (the accounts board, 2026-11-05): what was Rules (categories,
// rules, the bank's categories) and Devices (passkeys and sessions, AUTH.md),
// on one page. /rules and /devices redirect here.
export default async function SettingsPage() {
  const user = await requireUser();
  const demo = isDemoMode();
  const [rules, categories, bankRows, passkeys, sessions] = await Promise.all([
    getAllRules(),
    getCategories(),
    bankCategoryRows(),
    demo ? Promise.resolve([]) : getUserPasskeys(user.id),
    demo ? Promise.resolve([]) : activeSessions(user.id),
  ]);
  const categoryList = categories.map((c) => ({ id: c.id, name: c.name }));
  const categoryManagerList = categories.map((c) => ({
    id: c.id,
    name: c.name,
    isSplittable: c.isSplittable,
    countsAsSpending: c.countsAsSpending,
  }));
  const ruleList = rules.map((r) => ({
    id: r.id,
    matchPattern: r.matchPattern,
    matchType: r.matchType,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    priority: r.priority,
    mode: r.mode,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <section id="rules" className="scroll-mt-16 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Categories &amp; rules</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {ruleList.length === 0
                ? 'Define categories and categorize imports automatically'
                : `${categoryList.length} categories · ${ruleList.length} rule${ruleList.length === 1 ? '' : 's'}, matched in priority order`}
            </p>
          </div>
          <ApplyRulesButton />
        </div>
        <CategoriesManager categories={categoryManagerList} />
        <div className="space-y-1.5">
          <h3 className="px-1 text-[13px] font-medium">Rules</h3>
          {/* useTableState reads useSearchParams, which needs a Suspense
              boundary to prerender; params resolve client-side on hydration. */}
          <Suspense>
            <RulesManager rules={ruleList} categories={categoryList} />
          </Suspense>
        </div>
        <BankCategories
          rows={bankRows}
          categories={categories.filter((c) => c.countsAsSpending).map((c) => ({ id: c.id, name: c.name }))}
        />
      </section>

      <section id="devices" className="scroll-mt-16 space-y-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Devices</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {demo ? 'The demo has no sign-in.' : `Signed in as ${user.displayName}.`}
          </p>
        </div>
        {!demo && (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-medium">Passkeys</h3>
                <AddDeviceButton />
              </div>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                {passkeys.map((p) => (
                  <li key={p.id} className="px-4 py-2 text-sm">
                    {p.deviceLabel}
                    <div className="text-xs text-muted-foreground">{passkeyWhere(p)}</div>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                A passkey belongs to this site&apos;s address and to the password manager that made it: one made in Chrome is
                not offered by Safari, and the other way round. If the app moves to another domain, every passkey is made
                again with the setup token.
              </p>
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Signed in</h3>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
                    <div>
                      {deviceLabel(s.userAgent)}
                      <div className="text-xs text-muted-foreground">
                        since {formatWhen(s.createdAt)} · last seen {formatWhen(s.lastSeenAt)}
                      </div>
                    </div>
                    {s.id === user.sessionId ? (
                      <span className="text-xs text-muted-foreground">this device</span>
                    ) : (
                      <RevokeSessionButton sessionId={s.id} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
