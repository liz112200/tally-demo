'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { ArrowRight, Pencil, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { createRule, updateRule, deleteRule, applyRules } from '@/app/_actions/rules';
import {
  MATCH_TYPES,
  type RuleFormState,
  type ApplyRulesState,
} from '@/app/_lib/schema';
import { CategoryTag } from '@/app/_components/category-tag';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import {
  nextSort,
  readSort,
  sortPatch,
  sortRows,
  type SortSpec,
} from '@/lib/table-state';
import { useTableState } from '@/app/_lib/use-table-state';
import { SortBar } from '@/app/_components/sort-controls';
import { useReportSuccess } from './page-result';

type Category = { id: string; name: string };
type Rule = {
  id: string;
  matchPattern: string;
  matchType: string;
  categoryId: string;
  categoryName: string;
  priority: number;
  createdAt: string;
};

// Default order mirrors how the engine resolves rules: priority ascending,
// created_at breaking ties (the server already delivers that order, and
// sortRows is stable).
const RULES_SORT: SortSpec = {
  columns: ['priority', 'pattern', 'created'],
  defaultSort: 'priority',
  defaultDir: 'asc',
  firstDir: { created: 'desc' },
};

const RULE_SORT_OPTIONS = [
  { id: 'priority', label: 'priority' },
  { id: 'pattern', label: 'pattern' },
  { id: 'created', label: 'added' },
] as const;

const RULE_ACCESSORS: Record<string, (rule: Rule) => unknown> = {
  priority: (rule) => rule.priority,
  pattern: (rule) => rule.matchPattern,
  created: (rule) => rule.createdAt,
};

const initialState: RuleFormState = {};

const selectClass = cn(
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm',
  'outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
  'dark:bg-input/30',
);

function CategoryOptions({ categories }: { categories: Category[] }) {
  return (
    <>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </>
  );
}

export function RulesManager({
  rules,
  categories,
}: {
  rules: Rule[];
  categories: Category[];
}) {
  const { params, apply } = useTableState();
  const sort = readSort(params, RULES_SORT);
  const sorted = sortRows(rules, RULE_ACCESSORS[sort.sort], sort.dir);

  return (
    <div className="space-y-4">
      <AddRuleForm categories={categories} />

      <div className="space-y-1.5">
        {rules.length > 1 && (
          <SortBar
            className="justify-end px-1"
            options={RULE_SORT_OPTIONS}
            state={sort}
            onToggle={(id) =>
              apply(sortPatch(nextSort(sort, id, RULES_SORT), RULES_SORT))
            }
          />
        )}
        <div className="overflow-hidden rounded-xl border bg-card">
          {rules.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No rules yet. Add one above.
            </p>
          ) : (
            <ul className="divide-y">
              {sorted.map((rule) => (
                <RuleLine key={rule.id} rule={rule} categories={categories} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const initialApplyState: ApplyRulesState = {};

// Lives in the page header as a secondary action; the result note appears
// beneath the button after a run.
export function ApplyRulesButton() {
  const [state, formAction, pending] = useActionState(applyRules, initialApplyState);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        <Wand2 data-icon="inline-start" />
        {pending ? 'Applying…' : 'Apply to existing'}
      </Button>
      {state.ok && state.result && (
        <p className="text-xs text-muted-foreground">
          Matched {state.result.matched}, unmatched {state.result.unmatched},
          skipped {state.result.skippedManual} manually-set.
        </p>
      )}
    </form>
  );
}

// Saving a rule does not touch existing rows; said beside every Save, since
// nothing else on the page would show it.
const RULE_SCOPE = 'Applies to new rows; existing rows change when you apply rules.';

function AddRuleForm({ categories }: { categories: Category[] }) {
  const [state, formAction, pending] = useActionState(createRule, initialState);
  useReportSuccess(state);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid items-end gap-2 rounded-xl border border-dashed p-3 sm:grid-cols-[1fr_7rem_10rem_4.5rem_auto]"
    >
      <div className="grid gap-1">
        <Label htmlFor="add-pattern" className="text-xs text-muted-foreground">
          Pattern
        </Label>
        <Input
          id="add-pattern"
          name="matchPattern"
          placeholder="e.g. UBER"
          className="font-mono"
        />
        {state.errors?.matchPattern && (
          <p className="text-xs text-destructive">{state.errors.matchPattern}</p>
        )}
      </div>
      <div className="grid gap-1">
        <Label htmlFor="add-type" className="text-xs text-muted-foreground">
          Type
        </Label>
        <select id="add-type" name="matchType" className={selectClass} defaultValue="substring">
          {MATCH_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="add-category" className="text-xs text-muted-foreground">
          Category
        </Label>
        <select id="add-category" name="categoryId" className={selectClass} defaultValue="">
          <option value="" disabled>
            Choose…
          </option>
          <CategoryOptions categories={categories} />
        </select>
        {state.errors?.categoryId && (
          <p className="text-xs text-destructive">{state.errors.categoryId}</p>
        )}
      </div>
      <div className="grid gap-1">
        <Label htmlFor="add-priority" className="text-xs text-muted-foreground">
          Priority
        </Label>
        <Input
          id="add-priority"
          name="priority"
          type="number"
          defaultValue={100}
          className="font-mono"
        />
        {state.errors?.priority && (
          <p className="text-xs text-destructive">{state.errors.priority}</p>
        )}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add rule'}
      </Button>
      <p className="text-[11px] text-muted-foreground sm:col-span-5">{RULE_SCOPE}</p>
    </form>
  );
}

// One rule reads as a single line; clicking it expands the inline edit form.
// Save and cancel both land it back in the compact state.
function RuleLine({ rule, categories }: { rule: Rule; categories: Category[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateRule, initialState);
  useReportSuccess(state);

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="group flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted/40"
        >
          <span className="w-10 shrink-0 rounded bg-muted px-1 py-px text-center font-mono text-[11px] text-muted-foreground">
            {rule.priority}
          </span>
          <code className="font-mono">{rule.matchPattern}</code>
          <ArrowRight
            className="size-3 shrink-0 text-muted-foreground/60"
            aria-hidden
          />
          <CategoryTag name={rule.categoryName} source={null} />
          <span className="rounded border px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
            {rule.matchType}
          </span>
          <Pencil
            className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </button>
      </li>
    );
  }

  return (
    <li className="bg-muted/30 p-3">
      <form
        action={formAction}
        className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_10rem_4.5rem]"
      >
        <input type="hidden" name="id" value={rule.id} />
        <div className="grid gap-1">
          <Label
            htmlFor={`pattern-${rule.id}`}
            className="text-xs text-muted-foreground"
          >
            Pattern
          </Label>
          <Input
            id={`pattern-${rule.id}`}
            name="matchPattern"
            defaultValue={rule.matchPattern}
            className="font-mono"
          />
          {state.errors?.matchPattern && (
            <p className="text-xs text-destructive">{state.errors.matchPattern}</p>
          )}
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`type-${rule.id}`}
            className="text-xs text-muted-foreground"
          >
            Type
          </Label>
          <select
            id={`type-${rule.id}`}
            name="matchType"
            className={selectClass}
            defaultValue={rule.matchType}
          >
            {MATCH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`category-${rule.id}`}
            className="text-xs text-muted-foreground"
          >
            Category
          </Label>
          <select
            id={`category-${rule.id}`}
            name="categoryId"
            className={selectClass}
            defaultValue={rule.categoryId}
          >
            <CategoryOptions categories={categories} />
          </select>
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`priority-${rule.id}`}
            className="text-xs text-muted-foreground"
          >
            Priority
          </Label>
          <Input
            id={`priority-${rule.id}`}
            name="priority"
            type="number"
            defaultValue={rule.priority}
            className="font-mono"
          />
        </div>
        <div className="flex items-center gap-2 sm:col-span-4">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <span className="text-[11px] text-muted-foreground">{RULE_SCOPE}</span>
        </div>
      </form>
      {/* Outside the edit form: delete must not nest inside it. */}
      <div className="-mt-7 flex justify-end">
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete rule"
            >
              <Trash2 />
            </Button>
          }
          title={`Delete the ${rule.matchPattern} rule?`}
          description="Rows it categorized keep their category until rules are re-applied; new imports stop matching it immediately."
          confirmLabel="Delete rule"
          pendingLabel="Deleting…"
          onConfirm={async () => {
            const fd = new FormData();
            fd.set('id', rule.id);
            return deleteRule(fd);
          }}
        />
      </div>
    </li>
  );
}
