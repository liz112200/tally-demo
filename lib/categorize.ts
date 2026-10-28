// Pure rule-matching engine. Given a normalized merchant string and the rule
// set, returns the winning category id or null. No DB or framework imports; the
// caller fetches rules and passes them in.
export type CategoryRule = {
  categoryId: string;
  matchPattern: string;
  matchType: 'substring' | 'regex';
  priority: number;
  // Tie-breaker when priorities are equal. Date or ISO string.
  createdAt: string | Date;
};

function toTime(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function matches(merchantNormalized: string, rule: CategoryRule): boolean {
  if (rule.matchType === 'substring') {
    return merchantNormalized
      .toLowerCase()
      .includes(rule.matchPattern.toLowerCase());
  }
  try {
    // Case-insensitive per the categorization invariant. An invalid pattern
    // never matches rather than throwing mid-import.
    return new RegExp(rule.matchPattern, 'i').test(merchantNormalized);
  } catch {
    return false;
  }
}

// Lower priority wins; ties break by created_at ascending. The first rule that
// matches in that order decides the category.
export function categorize(
  merchantNormalized: string,
  rules: CategoryRule[],
): string | null {
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || toTime(a.createdAt) - toTime(b.createdAt),
  );
  for (const rule of ordered) {
    if (matches(merchantNormalized, rule)) return rule.categoryId;
  }
  return null;
}

export type RuleTarget = {
  categoryId: string | null;
  categorySource: 'manual' | 'rule' | 'bank' | null;
  hasSplit: boolean;
};

export type RuleOutcome = { categoryId: string | null; categorySource: 'rule' | 'bank' | null };

// What re-running the rules does to one existing row, given the category the
// rules matched (null for none) and, for a synced row, the owner's category
// for the bank's own category (null for none or unmapped). Returns the new
// category and source, or null when the row stays as it is:
//   - a manual category is the owner's and is never touched;
//   - a rule match sets the category (source 'rule'), over a bank one too:
//     rules come first;
//   - with no match, a synced row the bank categorizes takes that (source
//     'bank'), so it is visibly the bank's; otherwise a stale rule or bank
//     category is cleared, and a never-categorized row stays uncategorized;
//   - a row with a split is never moved into a category that is not
//     splittable: the split would keep counting in balances on a row the app
//     says cannot be split. It keeps its current category instead.
// Shared by the retroactive apply, bank sync and the bank-category apply, so
// they cannot disagree.
export function ruleOutcome(
  row: RuleTarget,
  matched: string | null,
  isSplittable: (categoryId: string) => boolean,
  bankFallback: string | null = null,
): RuleOutcome | null {
  if (row.categorySource === 'manual') return null;
  const [categoryId, categorySource]: [string | null, 'rule' | 'bank' | null] =
    matched !== null ? [matched, 'rule'] : bankFallback !== null ? [bankFallback, 'bank'] : [null, null];
  if (categoryId === null) {
    return row.categorySource === null ? null : { categoryId: null, categorySource: null };
  }
  if (row.hasSplit && !isSplittable(categoryId)) return null;
  if (row.categoryId === categoryId && row.categorySource === categorySource) return null;
  return { categoryId, categorySource };
}
