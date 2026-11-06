// Expenses by calendar month (the accounts board, 2026-11-05): the question
// there is what was spent when, the same months Insights uses; statement
// periods live on each account's page. Pure. Rows arrive sorted by date
// (either way) and keep their order; each month is one run of them.

export type MonthGroup<T> = { key: string; label: string; rows: T[] };

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function groupByMonth<T extends { date: string }>(rows: readonly T[], today: string): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push(row);
    else {
      const name = NAMES[Number(key.slice(5, 7)) - 1];
      groups.push({ key, label: key.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${key.slice(0, 4)}`, rows: [row] });
    }
  }
  return groups;
}
