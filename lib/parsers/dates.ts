// All three bank exports emit dates as MM/DD/YYYY; the canonical
// ParsedTransaction.date is ISO YYYY-MM-DD. This is the single conversion all
// parsers share. It validates shape and calendar range, but not that the day is
// valid for the month (e.g. 02/31) — the banks never emit impossible dates, and
// downstream is unaffected by the distinction.
const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function usDateToIso(input: string): string {
  const m = US_DATE.exec(input.trim());
  if (!m) {
    throw new Error(`Unrecognized US date (expected MM/DD/YYYY): ${JSON.stringify(input)}`);
  }
  const [, mm, dd, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Date out of range: ${JSON.stringify(input)}`);
  }
  return `${yyyy}-${mm}-${dd}`;
}
