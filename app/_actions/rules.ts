'use server';

import { revalidatePath } from 'next/cache';
import {
  insertRule,
  updateRuleById,
  deleteRuleById,
  applyRulesToExisting,
} from '@/db/queries';
import {
  ruleSchema,
  type RuleFormState,
  type ApplyRulesState,
} from '@/app/_lib/schema';

function fieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

// The unique index on (match_pattern, match_type) surfaces as Postgres 23505.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

function parseRuleForm(formData: FormData) {
  return ruleSchema.safeParse({
    matchPattern: formData.get('matchPattern'),
    matchType: formData.get('matchType'),
    categoryId: formData.get('categoryId'),
    priority: formData.get('priority'),
  });
}

export async function createRule(
  _prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  const parsed = parseRuleForm(formData);
  if (!parsed.success) return { errors: fieldErrors(parsed.error.issues) };

  try {
    await insertRule(parsed.data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { errors: { matchPattern: 'A rule with this pattern and type already exists' } };
    }
    throw err;
  }

  revalidatePath('/rules');
  revalidatePath('/');
  return { ok: true };
}

export async function updateRule(
  _prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return { errors: { matchPattern: 'Missing rule id' } };
  }

  const parsed = parseRuleForm(formData);
  if (!parsed.success) return { errors: fieldErrors(parsed.error.issues) };

  try {
    await updateRuleById(id, parsed.data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { errors: { matchPattern: 'A rule with this pattern and type already exists' } };
    }
    throw err;
  }

  revalidatePath('/rules');
  revalidatePath('/');
  return { ok: true };
}

// Retroactively apply the rules to existing transactions. Never overwrites a
// manual category; reports how many rows matched, went unmatched, or were
// skipped because they were manually set.
export async function applyRules(
  _prev: ApplyRulesState,
  _formData: FormData,
): Promise<ApplyRulesState> {
  const result = await applyRulesToExisting();
  revalidatePath('/');
  revalidatePath('/rules');
  return { ok: true, result };
}

// Plain form action (no validation surface needed for a delete).
export async function deleteRule(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id === 'string' && id.length > 0) {
    await deleteRuleById(id);
    revalidatePath('/rules');
    revalidatePath('/');
  }
}
