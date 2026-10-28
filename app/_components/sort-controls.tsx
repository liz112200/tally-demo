'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SortDir, SortState } from '@/lib/table-state';

// Column-header sort trigger: the label is the button, a chevron marks the
// active column and direction. Inactive headers reveal a muted chevron on
// hover so sortability is discoverable without cluttering the header row.
export function SortHeaderButton({
  label,
  active,
  dir,
  onToggle,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onToggle: () => void;
  className?: string;
}) {
  const Chevron = active && dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'group/sort inline-flex items-center gap-0.5 uppercase tracking-wider transition-colors hover:text-foreground',
        active && 'text-foreground',
        className,
      )}
    >
      {label}
      <Chevron
        className={cn(
          'size-3 shrink-0',
          active
            ? 'text-foreground'
            : 'opacity-0 transition-opacity group-hover/sort:opacity-60',
        )}
        aria-hidden
      />
    </button>
  );
}

// Compact sort bar for list-style pages (Rules, People) that have no column
// headers to click: "Sort:" followed by one toggle per key.
export function SortBar({
  options,
  state,
  onToggle,
  className,
}: {
  options: readonly { id: string; label: string }[];
  state: SortState;
  onToggle: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <span className="mr-0.5 uppercase tracking-wider">Sort</span>
      {options.map((option) => {
        const active = state.sort === option.id;
        const Chevron = active && state.dir === 'asc' ? ChevronUp : ChevronDown;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onToggle(option.id)}
            aria-pressed={active}
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 transition-colors hover:text-foreground',
              active && 'bg-muted font-medium text-foreground',
            )}
          >
            {option.label}
            {active && <Chevron className="size-3" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
