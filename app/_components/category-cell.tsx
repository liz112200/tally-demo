'use client';

import { useTransition } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { updateTransactionCategory } from '@/app/_actions/transactions';
import {
  UNCATEGORIZED,
  categoryIdToSentinel,
  sentinelToCategoryId,
} from '@/app/_lib/schema';
import { CategoryTag, categoryColorVar } from '@/app/_components/category-tag';

type Category = { id: string; name: string };

export function CategoryCell({
  transactionId,
  categoryId,
  categorySource,
  categories,
}: {
  transactionId: string;
  categoryId: string | null;
  categorySource: 'manual' | 'rule' | null;
  categories: Category[];
}) {
  const [pending, startTransition] = useTransition();

  const items: Record<string, string> = {
    [UNCATEGORIZED]: 'Uncategorized',
    ...Object.fromEntries(categories.map((c) => [c.id, c.name])),
  };
  const name = categoryId
    ? (categories.find((c) => c.id === categoryId)?.name ?? null)
    : null;

  return (
    <Select
      items={items}
      value={categoryIdToSentinel(categoryId)}
      disabled={pending}
      onValueChange={(v) =>
        startTransition(() =>
          updateTransactionCategory(transactionId, sentinelToCategoryId(v)),
        )
      }
    >
      {/* Ghost trigger: reads as table content until hovered, when the
          background and chevron appear to reveal it is editable. */}
      <SelectTrigger
        size="sm"
        className="-mx-1 h-6.5 border-transparent bg-transparent px-1 text-[13px] hover:bg-muted/70 dark:bg-transparent dark:hover:bg-muted/50 [&>svg]:opacity-0 [&>svg]:transition-opacity hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100"
      >
        {name ? (
          <CategoryTag name={name} source={categorySource} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNCATEGORIZED}>
          <span className="text-muted-foreground">Uncategorized</span>
        </SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: categoryColorVar(c.name) }}
              />
              {c.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
