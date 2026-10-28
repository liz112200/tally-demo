'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { postgresCode } from '@/lib/postgres-error';
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
import { requireUser } from '@/app/_lib/session';

function fieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

// The unique index on (match_pattern, match_type) surfaces as Postgres 23505,
// on the cause of Drizzle's wrapper error (lib/postgres-error.ts).
function isUniqueViolation(err: unknown): boolean {
  return postgresCode(err) === '23505';
}

function parseRuleForm(formData: FormData) {
  return ruleSchema.safeParse({
    matchPattern: formData.get('matchPattern'),
    matchType: formData.get('matchType'),
    categoryId: formData.get('categoryId'),
    priority: formData.get('priority'),
  });
}

// A rule touches only rows imported or synced after it is saved; existing
// rows change when rules are applied to them (applyRules). Said on the form
// and after every save, since nothing else would show it.
const RULE_SCOPE = 'Applies to new rows; existing rows change when you apply rules.';

export async function createRule(
  _prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  await requireUser();
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
  return { ok: true, message: `Rule ${parsed.data.matchPattern} added. ${RULE_SCOPE}` };
}

export async function updateRule(
  _prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  await requireUser();
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
  return { ok: true, message: `Rule ${parsed.data.matchPattern} saved. ${RULE_SCOPE}` };
}

// Retroactively apply the rules to existing transactions. Never overwrites a
// manual category; reports how many rows matched, went unmatched, or were
// skipped because they were manually set.
export async function applyRules(
  _prev: ApplyRulesState,
  _formData: FormData,
): Promise<ApplyRulesState> {
  await requireUser();
  const result = await applyRulesToExisting();
  revalidatePath('/');
  revalidatePath('/rules');
  return { ok: true, result };
}

// Plain form action (no validation surface needed for a delete).
export async function deleteRule(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return { error: 'Invalid rule.' };
  return attempt('deleteRule', async () => {
    const deleted = await deleteRuleById(id.data);
    if (!deleted) return { error: 'That rule was not found; it may already be deleted.' };
    revalidatePath('/rules');
    revalidatePath('/');
    return { ok: true, message: `Rule ${deleted.matchPattern} deleted. Rows it categorized keep their category.` };
  });
}
