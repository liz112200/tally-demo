'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import {
  hardDeletePersonById,
  insertPerson,
  renamePersonById,
  softDeletePersonById,
} from '@/db/queries';
import { personSchema, type PersonFormState } from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// Person data feeds the split editor on / as well, so every mutation
// revalidates both pages.
function revalidatePeople() {
  revalidatePath('/people');
  revalidatePath('/');
}

export async function createPerson(
  _prev: PersonFormState,
  formData: FormData,
): Promise<PersonFormState> {
  await requireUser();
  const parsed = personSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { errors: { name: parsed.error.issues[0]?.message ?? 'Invalid name' } };
  }
  await insertPerson(parsed.data.name);
  revalidatePeople();
  return { ok: true, message: `${parsed.data.name} added.` };
}

export async function renamePerson(
  _prev: PersonFormState,
  formData: FormData,
): Promise<PersonFormState> {
  await requireUser();
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return { errors: { name: 'Missing person id' } };
  }
  const parsed = personSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { errors: { name: parsed.error.issues[0]?.message ?? 'Invalid name' } };
  }
  await renamePersonById(id, parsed.data.name);
  revalidatePeople();
  return { ok: true };
}

// Soft delete; the query layer refuses the owner regardless of what the
// form submits.
export async function deletePerson(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return { error: 'Invalid person.' };
  return attempt('deletePerson', async () => {
    const deleted = await softDeletePersonById(id.data);
    if (!deleted) return { error: 'That person was not found, or is already deleted.' };
    revalidatePeople();
    return { ok: true, message: `${deleted.name} deleted. Their history stays; they no longer appear in new splits or settlements.` };
  });
}

// Permanently remove an already-soft-deleted person plus their settlements
// and any leftover share/assignment rows. Only offered in the UI for a
// deleted person with no active shares, so it never strips someone out of a
// live split. No undo.
export async function hardDeletePerson(id: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { error: 'Invalid person.' };
  return attempt('hardDeletePerson', async () => {
    const erased = await hardDeletePersonById(parsed.data);
    if (!erased) return { error: 'That person was not found, or is not deleted yet.' };
    revalidatePeople();
    const n = erased.settlements;
    return { ok: true, message: `${erased.name} erased, with ${n} settlement${n === 1 ? '' : 's'}.` };
  });
}
