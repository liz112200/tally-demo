// Money is represented as integer minor units. A minor unit is one THOUSANDTH
// of a dollar ("mills"): 1 dollar = 1000 units, so sub-cent amounts like
// 80.765 are exactly representable (80765 units). This was hundredths (cents)
// through phase 8; the unit widened to thousandths so three-decimal amounts
// are accepted without floats. The branded type and every `*_cents`
// field/column keep the historical "cents" name to avoid a repo-wide rename,
// but they now hold thousandths. `Cents` is a branded number so a raw number
// can never be passed where minor units are expected; `toCents` is the only
// constructor, and it enforces the "integer, no floats" invariant at runtime.
declare const centsBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: true };

// Minor units per dollar. Was 100 (cents); now 1000 (thousandths / mills).
export const MINOR_UNITS_PER_DOLLAR = 1000;
// Decimal places a dollar amount can carry, matching MINOR_UNITS_PER_DOLLAR.
export const MONEY_DECIMALS = 3;
// Legacy-to-current scale factor (hundredths -> thousandths), used by the
// receipt-extraction scaler and the one-time rescale data migration.
export const CENTS_TO_MINOR = 10;

export function toCents(n: number): Cents {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Cents must be a finite integer, received: ${n}`);
  }
  return n as Cents;
}

const DOLLARS_PATTERN = /^-?\d+(\.\d{1,3})?$/;

export function parseDollars(input: string): Cents {
  // Strip whitespace, the currency symbol, and thousands separators before
  // validating. The symbol is removed before the sign is read, so the
  // symbol-before-sign form ("$-12.34") is tolerated as lenient input even
  // though formatUSD only ever emits sign-before-symbol ("-$12.34").
  const cleaned = input.trim().replace(/\$/g, '').replace(/,/g, '');
  if (!DOLLARS_PATTERN.test(cleaned)) {
    throw new Error(`Invalid dollar amount: ${JSON.stringify(input)}`);
  }
  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole, frac = ''] = unsigned.split('.');
  // Integer/fraction split keeps the conversion off the float path entirely.
  // The fraction is right-padded to MONEY_DECIMALS so "12.3" -> 300 units.
  const cents =
    Number(whole) * MINOR_UNITS_PER_DOLLAR +
    Number(frac.padEnd(MONEY_DECIMALS, '0'));
  return toCents(negative ? -cents : cents);
}

// Non-throwing variant for validation paths (e.g. Zod refinements): returns
// null on exactly the inputs parseDollars rejects.
export function tryParseDollars(input: string): Cents | null {
  try {
    return parseDollars(input);
  } catch {
    return null;
  }
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return toCents(total);
}

// Divide a non-negative total into `count` integer shares that sum to the
// total exactly. Deterministic remainder rule (locked in CLAUDE.md): the
// first k shares each get one extra cent, in the caller-supplied order.
// Callers that split among people must order participants by person
// created_at ascending before calling.
export function distributeRemainder(totalCents: Cents, count: number): Cents[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Share count must be a positive integer, received: ${count}`);
  }
  if (totalCents < 0) {
    throw new Error(`Cannot distribute a negative total: ${totalCents}`);
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) =>
    toCents(i < remainder ? base + 1 : base),
  );
}

// Exact rendering for editable inputs (prefilled amounts the user may submit
// back): never rounds, so parseDollars round-trips to the stored value. For
// text shown to a reader, use formatUSD.
export function formatCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / MINOR_UNITS_PER_DOLLAR);
  const frac = abs % MINOR_UNITS_PER_DOLLAR;
  // Three-digit fraction, but drop a trailing zero so whole-cent amounts keep
  // the familiar two-decimal look ("12.34") while sub-cent amounts show the
  // third digit ("80.765"). Only one zero is trimmed, so the minimum is two
  // decimals and parseDollars round-trips exactly.
  let fracStr = String(frac).padStart(MONEY_DECIMALS, '0');
  if (fracStr.endsWith('0')) fracStr = fracStr.slice(0, MONEY_DECIMALS - 1);
  const body = `${whole.toLocaleString('en-US')}.${fracStr}`;
  return negative ? `-${body}` : body;
}

// Display formatting. Amounts are stored and computed in mills, but people
// read dollars and cents: every amount shown as text rounds to whole cents,
// half to even (bankers' rounding, so ties do not drift upward across a
// column of shares), and always prints two decimals. Display only — nothing
// stored or computed is rounded, and editable inputs keep the exact value
// via formatCents so what is saved is what was owed.
const MINOR_PER_CENT = MINOR_UNITS_PER_DOLLAR / 100;

// Minor units -> whole cents (hundredths), half to even.
export function roundHalfEvenToCents(minor: Cents): number {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_PER_CENT);
  const rest = abs - whole * MINOR_PER_CENT;
  const half = MINOR_PER_CENT / 2;
  const cents = rest > half || (rest === half && whole % 2 === 1) ? whole + 1 : whole;
  // A negative amount that rounds to zero is zero, not -0.
  return minor < 0 && cents !== 0 ? -cents : cents;
}

export function formatUSD(cents: Cents): string {
  const rounded = roundHalfEvenToCents(cents);
  const abs = Math.abs(rounded);
  const body = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return rounded < 0 ? `-$${body}` : `$${body}`;
}
