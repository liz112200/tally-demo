'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createCategory } from '@/app/_actions/categories';
import { type CategoryFormState } from '@/app/_lib/schema';
import { categoryColorVar } from '@/app/_components/category-tag';

export type CategoryItem = {
  id: string;
  name: string;
  isSplittable: boolean;
};

const initialState: CategoryFormState = {};

// The categories surface on /rules alongside rule editing: both are the
// categorization domain, and a rule needs a category to point at. Creating
// one here makes it available in every category selector across the app.
export function CategoriesManager({ categories }: { categories: CategoryItem[] }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4 px-1">
        <h2 className="text-[13px] font-medium">Categories</h2>
        <span className="text-xs text-muted-foreground">
          {categories.length} total
        </span>
      </div>
      <AddCategoryForm />
      <div className="overflow-hidden rounded-xl border bg-card">
        {categories.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No categories yet. Add one above.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 p-2.5">
            {categories.map((c) => (
              <li
                key={c.id}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryColorVar(c.name) }}
                />
                {c.name}
                {!c.isSplittable && (
                  <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    not splittable
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AddCategoryForm() {
  const [state, formAction, pending] = useActionState(createCategory, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  // Splittable by default (matches the column default). Non-splittable is
  // the exception, for the likes of Rent or Income.
  const [splittable, setSplittable] = useState(true);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setSplittable(true);
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid items-end gap-2 rounded-xl border border-dashed p-3 sm:grid-cols-[1fr_auto_auto]"
    >
      <div className="grid gap-1">
        <Label htmlFor="add-category-name" className="text-xs text-muted-foreground">
          Name
        </Label>
        <Input id="add-category-name" name="name" placeholder="e.g. Subscriptions" />
        {state.errors?.name && (
          <p className="text-xs text-destructive">{state.errors.name}</p>
        )}
      </div>
      <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
        {/* The action reads this string; a Base UI Checkbox alone submits
            nothing, so the hidden input carries the value. */}
        <input type="hidden" name="isSplittable" value={splittable ? 'true' : 'false'} />
        <Checkbox
          checked={splittable}
          onCheckedChange={(checked) => setSplittable(checked === true)}
          aria-label="Splittable"
        />
        Splittable
      </label>
      <Button type="submit" disabled={pending}>
        <Tag data-icon="inline-start" />
        {pending ? 'Adding…' : 'Add category'}
      </Button>
    </form>
  );
}
