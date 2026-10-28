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
  categorySource: 'manual' | 'rule' | null;
  hasSplit: boolean;
};

// What re-running the rules does to one existing row, given the category the
// rules matched (null for none). Returns the new category and source, or null
// when the row stays as it is:
//   - a manual category is the owner's and is never touched;
//   - a match sets the category (source 'rule'); no match clears a stale rule
//     category, and a never-categorized row stays uncategorized;
//   - a row with a split is never moved into a category that is not
//     splittable: the split would keep counting in balances on a row the app
//     says cannot be split. It keeps its current category instead.
// Shared by the retroactive apply and bank sync, so the two cannot disagree.
export function ruleOutcome(
  row: RuleTarget,
  matched: string | null,
  isSplittable: (categoryId: string) => boolean,
): { categoryId: string | null; categorySource: 'rule' | null } | null {
  if (row.categorySource === 'manual') return null;
  if (matched === null) {
    return row.categorySource === 'rule' ? { categoryId: null, categorySource: null } : null;
  }
  if (row.hasSplit && !isSplittable(matched)) return null;
  if (row.categoryId === matched && row.categorySource === 'rule') return null;
  return { categoryId: matched, categorySource: 'rule' };
}
