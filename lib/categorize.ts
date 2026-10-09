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
