import { Suspense } from 'react';
import { getRules, getCategories } from '@/db/queries';
import { RulesManager, ApplyRulesButton } from '@/app/_components/rules-manager';
import { CategoriesManager } from '@/app/_components/categories-manager';
import { requireUser } from '@/app/_lib/session';

export default async function RulesPage() {
  await requireUser();
  const [rules, categories] = await Promise.all([getRules(), getCategories()]);
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
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Categories &amp; rules
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {ruleList.length === 0
              ? 'Define categories and categorize imports automatically'
              : `${categoryList.length} categories · ${ruleList.length} rule${
                  ruleList.length === 1 ? '' : 's'
                }, matched in priority order`}
          </p>
        </div>
        <ApplyRulesButton />
      </div>
      <div className="space-y-6">
        <CategoriesManager categories={categoryManagerList} />
        <div className="space-y-1.5">
          <h2 className="px-1 text-[13px] font-medium">Rules</h2>
          {/* useTableState reads useSearchParams, which needs a Suspense
              boundary to prerender; params resolve client-side on hydration. */}
          <Suspense>
            <RulesManager rules={ruleList} categories={categoryList} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
