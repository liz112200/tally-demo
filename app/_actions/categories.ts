'use server';

import { revalidatePath } from 'next/cache';
import { insertCategory } from '@/db/queries';
import { postgresCode } from '@/lib/postgres-error';
import { categorySchema, type CategoryFormState } from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// Create a category from the manager on /rules. On success every category
// selector (Expenses, filters, rules, bulk categorize) needs the new
// option, so both pages that read categories revalidate.
export async function createCategory(
  _prev: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  await requireUser();
  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    // A checkbox absent from FormData means unchecked; the form sends the
    // explicit string so the default (splittable) survives a fresh submit.
    isSplittable: formData.get('isSplittable') === 'true',
    countsAsSpending: formData.get('countsAsSpending') !== 'false',
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
    }
    return { errors };
  }

  let created: boolean;
  try {
    ({ created } = await insertCategory(parsed.data));
  } catch (err) {
    // The schema already refuses this combination; the CHECK is the backstop.
    // Never echo the error: Drizzle's message is the failed SQL.
    if (postgresCode(err) === '23514') {
      return { errors: { isSplittable: 'A category that is not spending cannot be splittable' } };
    }
    throw err;
  }
  if (!created) {
    return { errors: { name: 'A category with that name already exists.' } };
  }

  revalidatePath('/');
  revalidatePath('/rules');
  return { ok: true };
}
