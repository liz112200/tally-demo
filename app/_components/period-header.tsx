'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatUSD, toCents } from '@/lib/money';
import { currentCycle, statementWords } from '@/lib/statement-cycles';
import { cycleSummary } from '@/lib/cycle-summary';
import { notShownText, statementComparison, type FoldedPeriods, type PeriodGroup, type PeriodStatement } from '@/lib/statement-periods';

// One statement period on an account's page (STATEMENT-CYCLES.md): its dates
// first and largest, its rows counted as the statement counts them, and
// whether the statement agrees, as a chip with the difference spelled out
// beneath. The reasoning behind the current cycle's close and the
// purchase-date caveat are on the page's header, said once, not per period.
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
  let count: string | null = null;
  if (group.kind === 'current') {
    const cycle = currentCycle(statements, today);
    const s = cycle ? cycleSummary({ cycle, statements, today, formatDay: day }) : null;
    title = s ? `This cycle · ${s.range}` : 'No statement recorded yet';
    count = s ? s.count : null;
  } else if (group.kind === 'statement') title = `${day(group.from!)} – ${day(group.to!)}`;
  else if (group.kind === 'gap') title = `${day(group.from!)} – ${day(group.to!)} · no recorded statement covers these dates`;
  else title = group.to ? `Before the recorded statements, to ${day(group.to)}` : 'Before the recorded statements';

  const comparison = statementComparison(group);
  const s = group.statement;
  const differs = comparison !== null && (comparison.chargesDiff !== 0 || comparison.creditsDiff !== 0);
  const side = (diff: number, stated: number, listed: number, word: string) =>
    diff === 0 ? null : `The statement says ${usd(stated)} in ${word}; these rows total ${usd(listed)}, ${usd(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'}.`;
  const chip =
    comparison === null
      ? group.kind === 'statement'
        ? { text: 'no totals recorded', tone: 'muted' as const }
        : null
      : !differs
        ? { text: 'matches the statement', tone: 'ok' as const }
        : {
            text: [comparison.chargesDiff, comparison.creditsDiff]
              .filter((d) => d !== 0)
              .map((d, i, all) => `${usd(Math.abs(d))} ${d < 0 ? 'under' : 'over'}${all.length > 1 ? (i === 0 ? ` in ${out}` : ` in ${back}`) : ''}`)
              .join(', '),
            tone: 'warn' as const,
          };
  const explained =
    differs && s
      ? [side(comparison!.chargesDiff, s.chargesCents!, group.chargesCents, out), side(comparison!.creditsDiff, s.creditsCents!, group.creditsCents, back)]
          .filter(Boolean)
          .join(' ')
      : null;

  const notes = [
    group.pendingCount > 0 ? `${group.pendingCount} pending, not on a statement yet` : null,
    group.alongsideCount > 0 ? `${group.alongsideCount} paid alongside, not on the statement` : null,
    group.postedOutsideRows > 0 ? `${group.postedOutsideRows} counted by the day the bank posted ${group.postedOutsideRows === 1 ? 'it' : 'them'}` : null,
    group.unverifiedCount > 0 ? `${group.unverifiedCount} from an account not yet verified: in these figures, not in spending` : null,
    notShownText(group.notShownHidden, group.notShownFiltered),
  ].filter(Boolean);

  const chipTone = {
    ok: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    muted: 'border-border bg-muted text-muted-foreground',
  };

  return (
    <tr className="border-b bg-muted/25">
      <td colSpan={colSpan} className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand period' : 'Collapse period'}
            className="flex min-h-8 items-center gap-1.5 rounded px-1 text-left hover:bg-muted/70"
          >
            <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-[13px] font-semibold text-foreground">{title}</span>
            {count && <span className="whitespace-nowrap text-xs text-muted-foreground">· {count}</span>}
          </button>
          {/* Statement figures, not Tally's spending: card payments and other
              transfers are in them, as the statement counts them. */}
          <span
            className="text-xs text-muted-foreground"
            title="Counted as the statement counts them: every posted row, card payments and other transfers included. Spending, which leaves transfers out, is on Expenses and Insights."
          >
            <span className="font-mono tabular-nums">{usd(group.chargesCents)}</span> {out} ·{' '}
            <span className="font-mono tabular-nums">{usd(group.creditsCents)}</span> {back}
          </span>
          {chip && <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${chipTone[chip.tone]}`}>{chip.text}</span>}
        </div>
        {explained && <p className="pl-7 pt-0.5 text-xs text-amber-800 dark:text-amber-300">{explained}</p>}
        {notes.length > 0 && <p className="pl-7 pt-0.5 text-xs text-muted-foreground">{notes.join(' · ')}</p>}
      </td>
    </tr>
  );
}

// A run of recorded statements with no rows and no totals, as one line.
export function FoldedPeriodsRow({ folded, colSpan, today }: { folded: FoldedPeriods; colSpan: number; today: string }) {
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    });
  return (
    <tr className="border-b bg-muted/10">
      <td colSpan={colSpan} className="px-9 py-1.5 text-xs text-muted-foreground">
        {folded.statements === 1 ? '1 statement' : `${folded.statements} statements`} with no rows · {day(folded.from)} – {day(folded.to)}
      </td>
    </tr>
  );
}
