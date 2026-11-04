'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatUSD, toCents } from '@/lib/money';
import { currentCycle, cycleHead, missingStatementNote, statementWords } from '@/lib/statement-cycles';
import { statementComparison, type PeriodGroup, type PeriodStatement } from '@/lib/statement-periods';

// One statement period's header in an account's tab (STATEMENT-CYCLES.md, the
// period view): its dates and how they are known, its rows counted as a
// statement counts them, the statement's own figures beside them when
// recorded, and every row the totals leave out, named.
export function PeriodHeader({
  group,
  collapsed,
  onToggle,
  colSpan,
  kind,
  statements,
  today,
}: {
  group: PeriodGroup<unknown>;
  collapsed: boolean;
  onToggle: () => void;
  colSpan: number;
  kind: 'card' | 'checking';
  statements: PeriodStatement[];
  today: string;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const day = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }), timeZone: 'UTC' });
  };
  const usd = (n: number) => formatUSD(toCents(n));
  const [out, back] = statementWords(kind);

  let title: string;
  let note: string | null = null;
  if (group.kind === 'current') {
    const cycle = currentCycle(statements, today);
    title = cycle ? cycleHead({ kind, cycle, today, formatDay: day }) : 'No statement recorded yet: record one on Accounts to see its periods';
    note = cycle ? missingStatementNote(cycle, day) : null;
  } else if (group.kind === 'statement') title = `Statement ${day(group.from!)} – ${day(group.to!)}`;
  else if (group.kind === 'gap') title = `${day(group.from!)} – ${day(group.to!)}: no recorded statement covers these dates`;
  else title = group.to ? `Before the recorded statements (to ${day(group.to)})` : 'Before the recorded statements';

  const comparison = statementComparison(group);
  const s = group.statement;
  const side = (diff: number, stated: number, listed: number, word: string) =>
    diff === 0 ? null : `the statement says ${usd(stated)} in ${word}; these rows total ${usd(listed)}, ${usd(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'}`;
  const compared =
    comparison && s
      ? comparison.chargesDiff === 0 && comparison.creditsDiff === 0
        ? `the statement says ${usd(s.chargesCents!)} and ${usd(s.creditsCents!)}: matches`
        : [side(comparison.chargesDiff, s.chargesCents!, group.chargesCents, out), side(comparison.creditsDiff, s.creditsCents!, group.creditsCents, back)]
            .filter(Boolean)
            .join('; ')
      : null;

  const leftOut = [
    group.pendingCount > 0 ? `${group.pendingCount} pending, not on a statement yet` : null,
    group.alongsideCount > 0 ? `${group.alongsideCount} paid alongside (manual, not on the statement)` : null,
  ].filter(Boolean);
  const caveats = [
    group.purchaseDatedCsvRows > 0
      ? 'Includes CSV rows dated by purchase, not posting: one near a closing day may belong to the neighbouring statement.'
      : null,
    group.postedOutsideRows > 0
      ? `${group.postedOutsideRows === 1 ? 'One row is' : `${group.postedOutsideRows} rows are`} counted by the day the bank posted ${group.postedOutsideRows === 1 ? 'it' : 'them'}, shown with the purchase date.`
      : null,
    // On the statement, so in its totals; not in spending until verified.
    group.unverifiedCount > 0
      ? `${group.unverifiedCount === 1 ? 'One row comes' : `${group.unverifiedCount} rows come`} from an account not yet verified: in these totals, as the statement counts ${group.unverifiedCount === 1 ? 'it' : 'them'}, but not in spending.`
      : null,
    note,
  ].filter(Boolean);

  return (
    <tr className="border-b bg-muted/25">
      <td colSpan={colSpan} className="px-2 py-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand period' : 'Collapse period'}
            className="flex items-center rounded p-0.5 hover:bg-muted/70"
          >
            <Chevron className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
          <span className="px-1 font-medium text-foreground">{title}</span>
          <span>
            <span className="font-mono">{group.count}</span> {group.count === 1 ? 'row' : 'rows'}
            {group.rows.length !== group.count && (
              <span>
                {' '}
                (<span className="font-mono">{group.rows.length}</span> shown)
              </span>
            )}
          </span>
          {/* Statement figures, not Tally's spending: card payments and other
              transfers are in them, as the statement counts them, so they
              differ from Insights and the summary strip on purpose. */}
          <span title="Counted as the statement counts them: every posted row, card payments and other transfers included. Spending, which leaves transfers out, is in the summary above.">
            <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide">statement figures</span>{' '}
            <span className="font-mono">{usd(group.chargesCents)}</span> in {out} · <span className="font-mono">{usd(group.creditsCents)}</span> in {back}
          </span>
          {compared && <span className={comparison && (comparison.chargesDiff !== 0 || comparison.creditsDiff !== 0) ? 'text-amber-700 dark:text-amber-400' : undefined}>{compared}</span>}
          {leftOut.length > 0 && <span>not in these totals: {leftOut.join(', ')}</span>}
        </div>
        {caveats.length > 0 && <div className="pl-7 text-[11px] text-muted-foreground">{caveats.join(' ')}</div>}
      </td>
    </tr>
  );
}
