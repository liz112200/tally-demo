import { formatUSD, toCents } from '@/lib/money';
import type { ImportSkipGroup } from '@/db/queries';

// Rows an import left out (import_skipped_rows): an omission stated, never
// silent. One disclosure per upload that skipped anything, its rows and why.
const WHY: Record<ImportSkipGroup['rows'][number]['reason'], string> = {
  duplicate: 'already in the ledger',
  duplicate_of_deleted: 'same as a row you deleted',
  covered: 'a linked bank syncs this date',
  collision: 'repeated within the file',
};

export function ImportSkips({ groups }: { groups: ImportSkipGroup[] }) {
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <details className="mt-6 rounded-lg border px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Rows not imported: <span className="font-mono">{total}</span> across {groups.length === 1 ? 'one upload' : `${groups.length} uploads`}
      </summary>
      <div className="mt-2 space-y-2">
        {groups.map((g) => {
          const counts = Object.entries(
            g.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {}),
          ).map(([reason, n]) => `${n} ${WHY[reason as keyof typeof WHY]}`);
          return (
            <details key={g.confirmId}>
              <summary className="cursor-pointer">
                {g.filename ?? 'Upload'} · {g.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {g.importName ? ` · into ${g.importName}` : ' · nothing imported'}
                <span className="text-muted-foreground"> · {counts.join(', ')}</span>
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
                {g.rows.map((r, i) => (
                  <li key={i}>
                    <span className="font-mono">{r.date}</span> · <span className="font-mono">{formatUSD(toCents(r.amountCents))}</span> ·{' '}
                    {r.descriptionRaw} · {WHY[r.reason]}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </details>
  );
}
