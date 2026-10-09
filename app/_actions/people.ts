'use server';

import { revalidatePath } from 'next/cache';
import {
  hardDeletePersonById,
  insertPerson,
  renamePersonById,
  softDeletePersonById,
} from '@/db/queries';
import { personSchema, type PersonFormState } from '@/app/_lib/schema';

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
  const parsed = personSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { errors: { name: parsed.error.issues[0]?.message ?? 'Invalid name' } };
  }
  await insertPerson(parsed.data.name);
  revalidatePeople();
  return { ok: true };
}

export async function renamePerson(
  _prev: PersonFormState,
  formData: FormData,
): Promise<PersonFormState> {
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
export async function deletePerson(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id === 'string' && id.length > 0) {
    await softDeletePersonById(id);
    revalidatePeople();
  }
}

// Permanently remove an already-soft-deleted person plus their settlements
// and any leftover share/assignment rows. Only offered in the UI for a
// deleted person with no active shares, so it never strips someone out of a
// live split. No undo.
export async function hardDeletePerson(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) return;
  await hardDeletePersonById(id);
  revalidatePeople();
}
