'use client';

import { Check, Copy, UsersRound } from 'lucide-react';
import type { PersonOption } from './split-editor';

export function assignmentLabel(ids: string[], persons: PersonOption[]): string {
  if (!ids.length) return 'Choose people';
  const active = new Map(persons.map((p) => [p.id, p.isOwner ? 'You' : p.name]));
  if (ids.some((id) => !active.has(id))) return ids.map((id) => active.get(id) ?? 'Inactive person').join(' · ');
  const absent = persons.filter((p) => !ids.includes(p.id));
  if (!absent.length) return 'Everyone';
  if (ids.length > 2 && absent.length === 1) return 'Everyone except ' + active.get(absent[0].id);
  if (ids.length > 3) return ids.length + ' people';
  return ids.map((id) => active.get(id)).join(' · ');
}

export function ItemAssignees({ persons, ids, item, mealGroup, previous, pending, onChange }: {
  persons: PersonOption[];
  ids: string[];
  item: string;
  mealGroup: string[];
  previous?: { description: string; ids: string[] };
  pending: boolean;
  onChange: (ids: string[]) => void;
}) {
  const active = persons.map((p) => p.id);
  const validIds = ids.filter((id) => active.includes(id));
  const everyone = validIds.length === active.length && ids.length === active.length;
  const reuse = previous && previous.ids.length > 0 && previous.ids.every((id) => active.includes(id));
  const quick = 'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium hover:bg-accent aria-pressed:border-primary aria-pressed:text-primary pointer-coarse:min-h-11';
  return <fieldset disabled={pending} className="min-w-0 rounded-lg border bg-muted/35 p-2.5">
    <legend className="sr-only">Assign {item}</legend>
    <div className="flex flex-wrap gap-1.5">
      {mealGroup.length > 1 && mealGroup.length < active.length && (
        <button type="button" className={quick} title="People assigned to the other dishes on this receipt"
          onClick={() => onChange(mealGroup)}><UsersRound className="size-3.5" aria-hidden />Meal group ({mealGroup.length})</button>
      )}
      <button type="button" className={quick} aria-pressed={everyone} onClick={() => onChange(active)}>
        <UsersRound className="size-3.5" aria-hidden />Everyone ({active.length})
      </button>
      {reuse && <button type="button" className={quick} title={'Use the same people as ' + previous.description}
        onClick={() => onChange([...previous.ids])}><Copy className="size-3.5" aria-hidden />Same as previous</button>}
    </div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {persons.map((p) => {
        const selected = ids.includes(p.id);
        return <button key={p.id} type="button" aria-pressed={selected}
          className="inline-flex min-h-8 items-center gap-1 rounded-full border border-input bg-card px-2.5 text-xs hover:border-primary aria-pressed:border-primary/50 aria-pressed:bg-accent aria-pressed:text-accent-foreground pointer-coarse:min-h-11"
          onClick={() => onChange(selected ? validIds.filter((id) => id !== p.id) : [...validIds, p.id])}>
          {selected && <Check className="size-3" aria-hidden />}{p.isOwner ? 'You' : p.name}
        </button>;
      })}
    </div>
  </fieldset>;
}
