'use server';

import { revalidatePath } from 'next/cache';
import { insertCategory } from '@/db/queries';
import { categorySchema, type CategoryFormState } from '@/app/_lib/schema';

// Create a category from the manager on /rules. On success every category
// selector (Expenses, filters, rules, bulk categorize) needs the new
// option, so both pages that read categories revalidate.
export async function createCategory(
  _prev: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    // A checkbox absent from FormData means unchecked; the form sends the
    // explicit string so the default (splittable) survives a fresh submit.
    isSplittable: formData.get('isSplittable') === 'true',
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
    }
    return { errors };
  }

  const { created } = await insertCategory(parsed.data);
  if (!created) {
    return { errors: { name: 'A category with that name already exists.' } };
  }

  revalidatePath('/');
  revalidatePath('/rules');
  return { ok: true };
}
