// The demo's synthetic ledger, built as plain rows ready to insert. Pure and
// deterministic: the same (seed, today) always yields identical rows, ids
// included. Dates are relative to `today`, so a daily reset keeps the data
// current.
//
// It is built the way the real app builds a ledger, through the same code:
// bank-format CSV text is rendered per statement and run through the real
// parsers (detectParser -> parsedTransactionSchema), merchants go through
// normalizeMerchant and the rules engine, rows hash with dedupHash, splits
// resolve through computeShares / computeItemShares, settlements FIFO-allocate
// with allocateFifo, and the netted payment comes from planNetting. Anything
// the app would reject, the builder throws on.
//
// Shape: about 90 days, three bank sources plus a few manual entries, at the
// per-source volume, category mix, and split rate of a real ledger. Balances
// are arranged so debt simplification visibly helps: the owner ends up even,
// one creditor's balance exactly matches one debtor's, and settling person by
// person takes more payments than the simplified set.
import { createRng, type Rng } from './rng';
import {
  CATEGORY_NAMES,
  CHASE_CARD_DATE,
  DEMO_RULES,
  GROCERY_ITEMS,
  MANUAL_ENTRIES,
  MERCHANTS,
  NON_SPLITTABLE,
  NOT_SPENDING,
  RESTAURANT_ITEMS,
  type DemoSource,
  type Merchant,
} from './catalog';
import { renderReceiptSvg } from './receipt-svg';
import { detectParser } from '../parsers/detect';
import { parsedTransactionSchema } from '../parsers/types';
import { normalizeMerchant } from '../parsers/normalize';
import { dedupHash } from '../parsers/dedup';
import { categorize, type CategoryRule } from '../categorize';
import { computeItemShares, computeShares } from '../split';
import { allocateFifo } from '../allocations';
import { planNetting } from '../netting';
import { computeBidirectionalBalances } from '../balances';
import { defaultImportName } from '../import-groups';
import { CENTS_TO_MINOR, toCents } from '../money';
import { BOUNDARY_DAYS, MATCH_DAYS, addDays, defaultCutover, setAsideValues, splitAtCutover } from '../bank-sync/cutover';
import { planSync, syncedRowValues } from '../bank-sync/plan';
import type { ProviderTransaction } from '../bank-sync/provider';
import { syntheticCursor, syntheticToken, type SyntheticDelivery, type SyntheticItem } from '../bank-sync/synthetic/provider';

export const DEMO_SEED = 20261009;

// The owner joins this many days before the reset day, at 09:00 UTC. The
// sample statement must be rebuilt against the same day the ledger was, so
// it is recovered from the stored owner row rather than from the clock (a
// visitor after midnight UTC, before the next reset, would otherwise get a
// statement whose overlap no longer matches).
const OWNER_JOINED_DAYS = 120;

export function seedDayFromOwnerCreatedAt(createdAt: Date): string {
  return new Date(createdAt.getTime() + OWNER_JOINED_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// ---- Output rows (column names mirror db/schema.ts) ----

export type DemoSeed = {
  today: string;
  ownerId: string;
  persons: { id: string; name: string; isOwner: boolean; createdAt: Date }[];
  categories: { id: string; name: string; isSplittable: boolean; countsAsSpending: boolean; createdAt: Date }[];
  rules: {
    id: string;
    matchPattern: string;
    matchType: 'substring' | 'regex';
    categoryId: string;
    priority: number;
    createdAt: Date;
  }[];
  imports: {
    id: string;
    source: DemoSource;
    filename: string;
    displayName: string;
    importedAt: Date;
    rowCount: number;
    ledgerAccountId: string | null;
  }[];
  // CSV and manual rows carry a dedup hash; synced rows carry the bank's id
  // instead (DEMO-SYNC.md), written by the same mapping a sync uses.
  transactions: {
    id: string;
    date: string;
    amountCents: number;
    descriptionRaw: string;
    categoryId: string | null;
    categorySource: 'manual' | 'rule' | 'bank' | null;
    source: DemoSource | 'manual' | 'plaid';
    importId: string | null;
    accountLabel: null;
    dedupHash: string | null;
    dedupExempt: boolean;
    merchantNormalized: string;
    note: string | null;
    bankAccountId: string | null;
    providerTransactionId: string | null;
    providerRaw: unknown;
    pending: boolean;
    createdAt: Date;
  }[];
  splits: {
    id: string;
    transactionId: string | null;
    payerPersonId: string;
    date: string | null;
    description: string | null;
    method: 'equal' | 'amount' | 'percent' | 'item';
    taxCents: number;
    tipCents: number;
    createdAt: Date;
  }[];
  splitShares: {
    id: string;
    splitId: string;
    personId: string;
    amountCents: number;
    inputAmountCents: number | null;
    inputPercent: number | null;
    createdAt: Date;
  }[];
  receipts: {
    id: string;
    transactionId: string;
    merchantExtracted: string;
    dateExtracted: string;
    subtotalCents: number;
    taxCents: number;
    tipCents: number;
    totalCents: number;
    createdAt: Date;
    // Uploaded by the writer; its URL fills blob_url and receipt_images.
    image: { pathname: string; svg: string };
  }[];
  receiptItems: {
    id: string;
    receiptId: string;
    position: number;
    description: string;
    quantity: number;
    amountCents: number;
    createdAt: Date;
  }[];
  receiptItemAssignments: { receiptItemId: string; personId: string }[];
  settlements: {
    id: string;
    personId: string;
    amountCents: number;
    direction: 'incoming' | 'outgoing';
    date: string;
    note: string | null;
    createdAt: Date;
    groupId: string | null;
    isOffset: boolean;
  }[];
  settlementAllocations: {
    settlementId: string;
    splitShareId: string;
    amountCents: number;
    createdAt: Date;
  }[];
  // The statement files the seeded imports were parsed from, by import id.
  statements: Record<string, string>;
  // Linked banks (DEMO-SYNC.md): one ledger account per CSV source, two
  // synthetic logins (Chase checking, Amex) synced through the real cutover
  // and planner, and what the synthetic provider serves from here on.
  ledgerAccounts: {
    id: string;
    displayName: string;
    csvSource: DemoSource;
    csvAccountLabel: null;
    cutoverBasis: 'posted' | 'transaction';
    cutoverDate: string | null;
    cutoverConfirmedAt: Date | null;
    createdAt: Date;
  }[];
  bankCategoryMap: { plaidCategory: string; categoryId: string; createdAt: Date }[];
  // Statements recorded per ledger account (STATEMENT-CYCLES.md): the one each
  // passed statement check adds, as the app records it.
  ledgerStatements: {
    ledgerAccountId: string;
    closingDate: string;
    periodStart: string | null;
    nextClosingDate: string | null;
    startsNewCycle: boolean;
    source: 'verification' | 'owner';
    createdAt: Date;
  }[];
  bankConnections: {
    id: string;
    provider: 'synthetic';
    providerItemId: string;
    institutionId: string;
    institutionName: string;
    accessTokenSealed: string;
    status: 'active';
    healthCheckedAt: Date;
    createdAt: Date;
  }[];
  bankAccounts: {
    id: string;
    connectionId: string;
    providerAccountId: string;
    name: string;
    mask: string;
    type: string;
    subtype: string;
    syncEnabled: true;
    syncCursor: string;
    lastSyncedAt: Date;
    ledgerAccountId: string;
    verifiedAt: Date | null;
    verification: Record<string, unknown> | null;
    boundaryReviewedAt: Date | null;
    createdAt: Date;
  }[];
  syncSkippedRows: (ReturnType<typeof setAsideValues> & {
    bankAccountId: string;
    providerTransactionId: string;
    reason: 'before_cutover' | 'possible_duplicate';
    createdAt: Date;
  })[];
  bankItems: SyntheticItem[];
  // Each linked account's last statement before its cutover, by provider
  // account id: what the verify page offers to fill in.
  bankStatements: Record<string, { from: string; to: string; chargesCents: number; creditsCents: number }>;
  // A newer Discover statement for visitors to import. Its oldest rows overlap
  // the last seeded statement, so a first import shows duplicates and a second
  // shows nothing new.
  sampleStatement: { filename: string; csv: string; rowCount: number; overlapCount: number };
};

// ---- People ----

const PEOPLE = [
  { key: 'owner', name: 'Riley', bank: 'RILEY MORGAN', joined: OWNER_JOINED_DAYS },
  { key: 'alex', name: 'Alex', bank: 'ALEX RIVERA', joined: 118 },
  { key: 'jordan', name: 'Jordan', bank: 'JORDAN LEE', joined: 112 },
  { key: 'casey', name: 'Casey', bank: 'CASEY BROOKS', joined: 108 },
  { key: 'sam', name: 'Sam', bank: 'SAM PATEL', joined: 101 },
  { key: 'priya', name: 'Priya', bank: 'PRIYA SHAH', joined: 97 },
  { key: 'morgan', name: 'Morgan', bank: 'MORGAN DIAZ', joined: 93 },
] as const;
type PersonKey = (typeof PEOPLE)[number]['key'];

// Who tags along on which kind of expense, and when they are around (days
// before today). Casey moved away early on and settled up in full.
const COMPANIONS: Record<string, { key: PersonKey; weight: number }[]> = {
  groceries: [{ key: 'alex', weight: 6 }, { key: 'casey', weight: 3 }, { key: 'jordan', weight: 1 }],
  dining: [
    { key: 'jordan', weight: 4 }, { key: 'morgan', weight: 3 }, { key: 'alex', weight: 2 },
    { key: 'casey', weight: 2 }, { key: 'sam', weight: 2 }, { key: 'priya', weight: 1 },
  ],
  ride: [{ key: 'jordan', weight: 3 }, { key: 'morgan', weight: 2 }, { key: 'alex', weight: 1 }],
  fun: [{ key: 'jordan', weight: 2 }, { key: 'morgan', weight: 2 }, { key: 'sam', weight: 1 }],
  travel: [{ key: 'jordan', weight: 1 }],
  utility: [{ key: 'alex', weight: 1 }],
};
const AROUND: Record<PersonKey, [number, number]> = {
  owner: [0, 999], alex: [0, 999], jordan: [0, 999], casey: [50, 999],
  sam: [25, 999], priya: [0, 999], morgan: [0, 999],
};

// ---- Calendar ----

const WINDOW_DAYS = 91;
// Statement periods: each ends on this many days before today (inclusive)
// and is downloaded the day after. Rows newer than the last end have not
// been imported yet; the Discover ones become the sample statement.
const PERIOD_ENDS = [70, 40, 10];
const SAMPLE_FROM = 12; // sample statement covers days 12..1 (overlaps 12..10)
// Real spending skews to Mondays (weekend posts) and Saturdays.
const WEEKDAY_WEIGHT = [20, 66, 43, 28, 26, 29, 47]; // Sun..Sat
const MEAN_WEEKDAY_WEIGHT = WEEKDAY_WEIGHT.reduce((a, b) => a + b, 0) / 7;

const TRIP_DAY = 48;
// The scripted car hire's CSV row, raised by the owner after import to fold
// in what Jordan owed for gas, then split by amount: half the hire each, the
// gas on Jordan's share.
const RAISED_BY_CENTS = 3_800;
const RAISED_NOTE = 'Raised by $38.00 to fold in the gas Jordan owed me.';
const MONTHLY = new Set(['spotify', 'netflix', 'youtube', 'apple', 'comed', 'xfinity', 'statefarm', 'rent', 'interest']);
const FIXED_DAY: Record<string, number> = { rent: 1, interest: 28 };

function dayToDate(today: string, daysAgo: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
function stamp(today: string, daysAgo: number, hour: number): Date {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour);
  return d;
}
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const dollars = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
// Smaller of two uniform draws: skews toward the cheap end like card spend.
function drawCents(rng: Rng, m: Merchant): number {
  if ('fixed' in m.amounts) return rng.pick(m.amounts.fixed);
  const [lo, hi] = m.amounts.range;
  const a = rng.int(Math.min(lo, hi), Math.max(lo, hi));
  const b = rng.int(Math.min(lo, hi), Math.max(lo, hi));
  return lo < 0 ? Math.max(a, b) : Math.min(a, b);
}

// ---- Bank rows ----

type RawRow = {
  id: string;
  // A row placed on purpose for the linked-bank demonstrations
  // (DEMO-SYNC.md, Showing the hard part); never split at random.
  scripted?: 'held' | 'raised' | 'split';
  source: DemoSource | 'manual';
  daysAgo: number;
  date: string;
  cents: number; // canonical: spending positive
  description: string;
  merchant: Merchant | null;
  bankCategory: string;
  chaseType: string;
  manualCategory: string | null;
};

export function buildDemoSeed(today: string, seed: number = DEMO_SEED): DemoSeed {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be YYYY-MM-DD: ${today}`);
  const root = createRng(seed);
  const ids = root.fork('ids');
  const pick = root.fork('choices');

  // People and reference data.
  const persons = PEOPLE.map((p, i) => ({
    id: ids.uuid(),
    name: p.name,
    isOwner: p.key === 'owner',
    createdAt: stamp(today, p.joined, 9 + i),
  }));
  const personId = Object.fromEntries(PEOPLE.map((p, i) => [p.key, persons[i].id])) as Record<PersonKey, string>;
  const personOrder = persons.map((p) => p.id); // created_at ascending
  const ownerId = personId.owner;

  const categories = CATEGORY_NAMES.map((name, i) => ({
    id: ids.uuid(),
    name,
    isSplittable: !(NON_SPLITTABLE as readonly string[]).includes(name),
    countsAsSpending: !(NOT_SPENDING as readonly string[]).includes(name),
    createdAt: new Date(stamp(today, 120, 8).getTime() + i * 1000),
  }));
  const categoryId = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  const rules = DEMO_RULES.map((r, i) => ({
    id: ids.uuid(),
    matchPattern: r.matchPattern,
    matchType: r.matchType,
    categoryId: categoryId[r.category],
    priority: r.priority,
    createdAt: new Date(stamp(today, 119, 10).getTime() + i * 1000),
  }));
  const engineRules: CategoryRule[] = rules.map((r) => ({ ...r }));

  // 1. Card and checking activity across the window.
  const rows: RawRow[] = [];
  const addRow = (r: Omit<RawRow, 'id' | 'date'>) => {
    const row = { ...r, id: ids.uuid(), date: dayToDate(today, r.daysAgo) };
    rows.push(row);
    return row;
  };
  for (const m of MERCHANTS) {
    const stream = root.fork(`merchant:${m.key}`);
    const fixedDay = FIXED_DAY[m.key] ?? stream.int(2, 27);
    for (let d = WINDOW_DAYS; d >= 1; d -= 1) {
      const date = dayToDate(today, d);
      let hit: boolean;
      if (MONTHLY.has(m.key)) {
        hit = Number(date.slice(8, 10)) === fixedDay;
      } else if (m.key === 'payroll') {
        hit = (d + fixedDay) % 14 === 0;
      } else if (m.key === 'airbnb') {
        // One scripted weekend away, split by percent: every reset has one.
        hit = d === TRIP_DAY;
      } else {
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        hit = stream.next() < (m.perMonth / 30) * (WEEKDAY_WEIGHT[dow] / MEAN_WEEKDAY_WEIGHT);
      }
      if (!hit) continue;
      addRow({
        source: m.source,
        daysAgo: d,
        cents: drawCents(stream, m),
        description: m.describe(stream).replace(CHASE_CARD_DATE, `${date.slice(5, 7)}/${date.slice(8, 10)}`),
        merchant: m,
        bankCategory: m.bankCategory ?? '',
        chaseType: m.chaseType ?? '',
        manualCategory: m.manualCategory ?? null,
      });
    }
  }
  // Scripted Amex rows (DEMO-SYNC.md, Showing the hard part). Amex is the
  // rarely used card, so these are placed rather than drawn: a purchase on
  // the last statement day that the bank sends days later with no
  // authorized date (the cutover holds it), a car hire whose CSV row the
  // owner raised (the boundary review states the difference), and a flight
  // after the cutover, split with Jordan, whose amount the bank later
  // changes.
  {
    const scripted = root.fork('scripted');
    const merchant = (key: string) => MERCHANTS.find((m) => m.key === key)!;
    for (const [kind, key, daysAgo] of [
      ['held', 'amex-wholefoods', Math.min(...PERIOD_ENDS)],
      ['raised', 'hertz', Math.min(...PERIOD_ENDS) + 3],
      ['split', 'delta', 5],
    ] as const) {
      const m = merchant(key);
      addRow({
        source: 'amex', daysAgo, cents: drawCents(scripted, m), description: m.describe(scripted),
        merchant: m, bankCategory: '', chaseType: '', manualCategory: null, scripted: kind,
      });
    }
  }
  // Card payments: each card's balance for the prior month is paid from
  // checking, so the card shows a credit and checking the matching debit.
  const payments = root.fork('payments');
  for (const card of ['discover', 'amex'] as const) {
    const payDay = card === 'discover' ? 6 : 12;
    for (let d = WINDOW_DAYS; d >= 1; d -= 1) {
      const date = dayToDate(today, d);
      if (Number(date.slice(8, 10)) !== payDay) continue;
      const balance = rows
        .filter((r) => r.source === card && r.daysAgo > d && r.daysAgo <= d + 30 && r.cents > 0)
        .reduce((acc, r) => acc + r.cents, 0);
      if (balance <= 0) continue;
      const digits = String(payments.int(1_000_000_000, 9_999_999_999));
      addRow({
        source: card, daysAgo: d, cents: -balance,
        description: card === 'discover' ? 'INTERNET PAYMENT - THANK YOU' : 'ONLINE PAYMENT - THANK YOU',
        merchant: null, bankCategory: 'Payments and Credits', chaseType: '', manualCategory: null,
      });
      addRow({
        source: 'chase', daysAgo: d, cents: balance,
        description: card === 'discover'
          ? `DISCOVER         E-PAYMENT            WEB ID: ${digits}`
          : `AMEX EPAYMENT    ACH PMT    W${digits.slice(0, 6)}     WEB ID: ${digits}`,
        merchant: null, bankCategory: '', chaseType: 'ACH_DEBIT', manualCategory: null,
      });
    }
  }
  // Cash spending typed in by hand, spread across the window.
  MANUAL_ENTRIES.forEach((e, i) => {
    addRow({
      source: 'manual',
      daysAgo: 84 - i * 10 - pick.int(0, 4),
      cents: e.amountCents,
      description: e.description,
      merchant: null, bankCategory: '', chaseType: '',
      manualCategory: e.category,
    });
  });

  // Which rows have been imported (or typed in): a bank row is in the
  // ledger once its statement period has been downloaded, the day after the
  // period ends. Period i covers days [PERIOD_ENDS[i], PERIOD_ENDS[i-1]).
  const lastEnd = Math.min(...PERIOD_ENDS);
  const periodOf = (daysAgo: number) => PERIOD_ENDS.findIndex((end) => daysAgo >= end);
  const importedAt = (period: number) => stamp(today, PERIOD_ENDS[period] - 1, 19);
  const inLedger = (r: RawRow) => r.source === 'manual' || periodOf(r.daysAgo) >= 0;
  const createdAt = (r: RawRow): Date =>
    r.source === 'manual' ? stamp(today, r.daysAgo, 21) : importedAt(periodOf(r.daysAgo));

  // 2. Categories: rules first, then the owner's hand edits.
  const category = new Map<string, { id: string | null; source: 'manual' | 'rule' | null }>();
  const categorizeRow = (r: RawRow) => {
    if (r.source === 'manual') {
      category.set(r.id, r.manualCategory
        ? { id: categoryId[r.manualCategory], source: 'manual' }
        : { id: null, source: null });
      return;
    }
    const ruled = categorize(normalizeMerchant(r.description), engineRules);
    const override = r.merchant?.override;
    if (ruled && override && pick.chance(override.p)) {
      category.set(r.id, { id: categoryId[override.category], source: 'manual' });
    } else if (ruled) category.set(r.id, { id: ruled, source: 'rule' });
    else if (r.manualCategory && pick.chance(0.9)) {
      category.set(r.id, { id: categoryId[r.manualCategory], source: 'manual' });
    } else category.set(r.id, { id: null, source: null });
  };
  rows.forEach(categorizeRow);

  // 3. Splits on imported spending.
  type Split = DemoSeed['splits'][number];
  type Share = DemoSeed['splitShares'][number];
  const splits: Split[] = [];
  const shares: Share[] = [];
  const receipts: DemoSeed['receipts'] = [];
  const receiptItems: DemoSeed['receiptItems'] = [];
  const assignments: DemoSeed['receiptItemAssignments'] = [];
  // Which person each share belongs to and its FIFO date, for allocation.
  const shareMeta = new Map<string, { person: string; direction: 'incoming' | 'outgoing'; effective: string; created: Date }>();

  const addShares = (split: Split, resolved: { personId: string; amountCents: number; inputAmountCents?: number | null; inputPercent?: number | null }[], effective: string) => {
    for (const s of resolved) {
      const share: Share = {
        id: ids.uuid(),
        splitId: split.id,
        personId: s.personId,
        amountCents: s.amountCents,
        inputAmountCents: s.inputAmountCents ?? null,
        inputPercent: s.inputPercent ?? null,
        createdAt: split.createdAt,
      };
      shares.push(share);
      const external = split.transactionId === null;
      if (external) {
        shareMeta.set(share.id, { person: split.payerPersonId, direction: 'outgoing', effective, created: split.createdAt });
      } else if (s.personId !== ownerId) {
        shareMeta.set(share.id, { person: s.personId, direction: 'incoming', effective, created: split.createdAt });
      }
    }
  };

  const chooser = root.fork('splits');
  let itemSplits = 0;
  let percentSplits = 0;
  const candidates = rows
    .filter((r) => inLedger(r) && r.source !== 'manual' && r.cents > 0 && r.merchant?.split && !r.scripted)
    .filter((r) => {
      const c = category.get(r.id)!;
      return !c.id || categories.find((x) => x.id === c.id)!.isSplittable;
    })
    .sort((a, b) => b.daysAgo - a.daysAgo || a.id.localeCompare(b.id));

  for (const row of candidates) {
    const spec = row.merchant!.split!;
    if (!chooser.chance(spec.p)) continue;
    const available = COMPANIONS[spec.kind].filter(
      (c) => row.daysAgo >= AROUND[c.key][0] && row.daysAgo <= AROUND[c.key][1],
    );
    if (available.length === 0) continue;
    const first = chooser.weighted(available.map((c) => ({ value: c.key, weight: c.weight })));
    const companions = new Set<PersonKey>([first]);
    if (['dining', 'ride', 'fun'].includes(spec.kind) && chooser.chance(0.15)) {
      const others = available.filter((c) => c.key !== first);
      if (others.length > 0) companions.add(chooser.pick(others).key);
    }
    const participantIds = personOrder.filter(
      (id) => id === ownerId || [...companions].some((k) => personId[k] === id),
    );
    const amount = toCents(row.cents * CENTS_TO_MINOR);
    const split: Split = {
      id: ids.uuid(),
      transactionId: row.id,
      payerPersonId: ownerId,
      date: null,
      description: null,
      method: 'equal',
      taxCents: 0,
      tipCents: 0,
      createdAt: new Date(createdAt(row).getTime() + chooser.int(2, 40) * 3_600_000),
    };

    if (spec.kind === 'utility') {
      // Utilities by amount: the roommate covers a little under half.
      const theirs = Math.floor((row.cents * 45) / 100) * CENTS_TO_MINOR;
      const inputs = participantIds.map((id) => (id === ownerId ? amount - theirs : theirs));
      split.method = 'amount';
      splits.push(split);
      addShares(
        split,
        computeShares(amount, toCents(0), toCents(0), 'amount', participantIds.map((personId) => ({ personId })), inputs)
          .map((s, i) => ({ ...s, inputAmountCents: inputs[i] })),
        row.date,
      );
    } else if ((spec.kind === 'travel' && row.merchant!.key === 'airbnb') || (row.merchant!.key === 'costco' && percentSplits < 2)) {
      // Lodging and bulk shopping by percent: the owner takes the larger part.
      const percents = participantIds.length === 2 ? [60, 40] : distributePercents(participantIds.length);
      split.method = 'percent';
      percentSplits += 1;
      splits.push(split);
      addShares(
        split,
        computeShares(amount, toCents(0), toCents(0), 'percent', participantIds.map((personId) => ({ personId })), percents)
          .map((s, i) => ({ ...s, inputPercent: percents[i] })),
        row.date,
      );
    } else if (spec.receipt && itemSplits < 16 && chooser.chance(0.45)) {
      itemSplits += 1;
      const built = buildReceipt(chooser, ids, row, spec.receipt, participantIds, ownerId, personOrder);
      split.method = 'item';
      split.taxCents = built.receipt.taxCents;
      split.tipCents = built.receipt.tipCents;
      built.receipt.createdAt = new Date(split.createdAt.getTime() - 600_000);
      for (const item of built.items) item.createdAt = built.receipt.createdAt;
      receipts.push(built.receipt);
      receiptItems.push(...built.items);
      assignments.push(...built.assignments);
      splits.push(split);
      addShares(split, built.shares, row.date);
    } else {
      splits.push(split);
      addShares(
        split,
        computeShares(amount, toCents(0), toCents(0), 'equal', participantIds.map((personId) => ({ personId }))),
        row.date,
      );
    }
  }

  // The scripted flight, synced after the cutover, split equally with
  // Jordan. Its transaction id is its row id, as the synced insert below.
  {
    const flight = rows.find((r) => r.scripted === 'split')!;
    const participantIds = personOrder.filter((id) => id === ownerId || id === personId.jordan);
    const split: Split = {
      id: ids.uuid(), transactionId: flight.id, payerPersonId: ownerId, date: null, description: null,
      method: 'equal', taxCents: 0, tipCents: 0, createdAt: stamp(today, flight.daysAgo - 2, 20),
    };
    splits.push(split);
    addShares(
      split,
      computeShares(toCents(flight.cents * CENTS_TO_MINOR), toCents(0), toCents(0), 'equal', participantIds.map((personId) => ({ personId }))),
      flight.date,
    );
  }

  // The raised car hire, split by amount on its raised total.
  {
    const hire = rows.find((r) => r.scripted === 'raised')!;
    const participantIds = personOrder.filter((id) => id === ownerId || id === personId.jordan);
    const half = Math.floor(hire.cents / 2);
    const theirs = (hire.cents - half + RAISED_BY_CENTS) * CENTS_TO_MINOR;
    const amount = (hire.cents + RAISED_BY_CENTS) * CENTS_TO_MINOR;
    const inputs = participantIds.map((id) => (id === ownerId ? amount - theirs : theirs));
    const split: Split = {
      id: ids.uuid(), transactionId: hire.id, payerPersonId: ownerId, date: null, description: null,
      method: 'amount', taxCents: 0, tipCents: 0, createdAt: new Date(createdAt(hire).getTime() + 26 * 3_600_000),
    };
    splits.push(split);
    addShares(
      split,
      computeShares(toCents(amount), toCents(0), toCents(0), 'amount', participantIds.map((personId) => ({ personId })), inputs)
        .map((sh, i) => ({ ...sh, inputAmountCents: inputs[i] })),
      hire.date,
    );
  }

  // 4. Expenses other people paid (external splits): the owner owes a share.
  const external = (who: PersonKey, daysAgo: number, description: string, ownerCents: number) => {
    const split: Split = {
      id: ids.uuid(),
      transactionId: null,
      payerPersonId: personId[who],
      date: dayToDate(today, daysAgo),
      description,
      method: 'equal',
      taxCents: 0,
      tipCents: 0,
      createdAt: stamp(today, daysAgo, 20),
    };
    splits.push(split);
    // External FIFO dates by created_at (see getDebtShares).
    addShares(split, [{ personId: ownerId, amountCents: toCents(ownerCents) }], split.createdAt.toISOString().slice(0, 10));
  };
  external('priya', 76, 'Cabin deposit (Priya booked)', 180_000);
  external('morgan', 56, 'Concert tickets', 68_500);
  external('sam', 52, "Dinner at Nonna's", 46_500);
  external('priya', 44, 'Grocery run for the potluck', 42_350);
  external('morgan', 39, 'Ski rental', 54_000);

  // 5. Settlements, FIFO-allocated like the app does.
  const settlements: DemoSeed['settlements'] = [];
  const allocations: DemoSeed['settlementAllocations'] = [];
  const allocated = new Map<string, number>();
  const outstandingShares = (who: PersonKey, direction: 'incoming' | 'outgoing', asOf: Date, effectiveBy: string) =>
    shares
      .filter((s) => {
        const m = shareMeta.get(s.id);
        return m && m.person === personId[who] && m.direction === direction && m.created <= asOf && m.effective <= effectiveBy;
      })
      .map((s) => ({ s, m: shareMeta.get(s.id)! }))
      .sort((a, b) =>
        a.m.effective.localeCompare(b.m.effective) ||
        a.m.created.getTime() - b.m.created.getTime() ||
        a.s.id.localeCompare(b.s.id))
      .map(({ s }) => ({ shareId: s.id, outstandingCents: s.amountCents - (allocated.get(s.id) ?? 0) }))
      .filter((s) => s.outstandingCents > 0);
  const applyAllocations = (settlementId: string, list: { shareId: string; amountCents: number }[], at: Date) => {
    for (const a of list) {
      allocations.push({ settlementId, splitShareId: a.shareId, amountCents: a.amountCents, createdAt: at });
      allocated.set(a.shareId, (allocated.get(a.shareId) ?? 0) + a.amountCents);
    }
  };
  const zelle = root.fork('zelle');
  const bankEcho = (who: PersonKey, daysAgo: number, direction: 'incoming' | 'outgoing', minor: number) => {
    const ref = `JPM99${zelle.int(100000, 999999)}`;
    const name = PEOPLE.find((p) => p.key === who)!.bank;
    addRow({
      source: 'chase', daysAgo,
      cents: (direction === 'incoming' ? -minor : minor) / CENTS_TO_MINOR,
      description: direction === 'incoming' ? `Zelle payment from ${name} ${ref}` : `Zelle payment to ${name} ${ref}`,
      merchant: null, bankCategory: '', chaseType: direction === 'incoming' ? 'QUICKPAY_CREDIT' : 'QUICKPAY_DEBIT',
      manualCategory: null,
    });
    categorizeRow(rows[rows.length - 1]);
  };
  // Pay `who` down for debts dated on or before `coverBy` days ago, rounded
  // down to whole dollars (so the newest covered share is usually partial),
  // or exactly when `exact`.
  const settle = (who: PersonKey, daysAgo: number, coverBy: number, opts: { direction?: 'incoming' | 'outgoing'; fraction?: number; exact?: boolean; note: string; echo: boolean }) => {
    const direction = opts.direction ?? 'incoming';
    const at = stamp(today, daysAgo, 18);
    const open = outstandingShares(who, direction, at, dayToDate(today, coverBy));
    const owed = open.reduce((acc, s) => acc + s.outstandingCents, 0);
    let amount = Math.floor((owed * (opts.fraction ?? 1)) / 1000) * 1000;
    if (opts.exact) amount = owed;
    if (amount <= 0) return;
    const { allocations: placed, unallocatedCents } = allocateFifo(amount, open);
    if (unallocatedCents !== 0) throw new Error('Seed settlement would leave credit');
    const id = ids.uuid();
    settlements.push({
      id, personId: personId[who], amountCents: amount, direction,
      date: dayToDate(today, daysAgo), note: opts.note, createdAt: at, groupId: null, isOffset: false,
    });
    applyAllocations(id, placed.map((p) => ({ shareId: p.splitShareId, amountCents: p.amountCents })), at);
    if (opts.echo && amount % CENTS_TO_MINOR === 0) bankEcho(who, daysAgo, direction, amount);
  };
  settle('casey', 60, 62, { note: 'Zelle', echo: true, fraction: 0.8 });
  settle('alex', 61, 64, { note: 'Zelle', echo: true });
  settle('priya', 36, 70, { direction: 'outgoing', note: 'Paid back the cabin deposit', echo: true, exact: true });
  settle('jordan', 34, 45, { note: 'Venmo', echo: false, fraction: 0.6 });
  settle('alex', 32, 42, { note: 'Zelle', echo: true });
  settle('casey', 30, 0, { note: 'Zelle — all square', echo: true, exact: true });

  // Morgan: owed both ways, settled in one netted payment (cash for the
  // difference, an offset pair for the overlap), as /people records it.
  {
    const daysAgo = 31;
    const at = stamp(today, daysAgo, 18);
    const asAlloc = (list: { shareId: string; outstandingCents: number }[]) =>
      list.map((s) => ({ shareId: s.shareId, amountCents: s.outstandingCents }));
    const result = planNetting(
      asAlloc(outstandingShares('morgan', 'incoming', at, dayToDate(today, daysAgo))),
      asAlloc(outstandingShares('morgan', 'outgoing', at, dayToDate(today, daysAgo))),
      null,
    );
    if (!result.ok) throw new Error(`Seed netting failed: ${result.reason}`);
    const { plan } = result;
    const groupId = ids.uuid();
    const base = { personId: personId.morgan, date: dayToDate(today, daysAgo), createdAt: at, groupId };
    if (plan.cash) {
      const id = ids.uuid();
      settlements.push({ ...base, id, amountCents: plan.cash.amountCents, direction: plan.cash.direction, note: 'Settled up both ways', isOffset: false });
      applyAllocations(id, plan.cash.allocations, at);
      if (plan.cash.amountCents % CENTS_TO_MINOR === 0) bankEcho('morgan', daysAgo, plan.cash.direction, plan.cash.amountCents);
    }
    if (plan.offset) {
      for (const direction of ['incoming', 'outgoing'] as const) {
        const id = ids.uuid();
        settlements.push({ ...base, id, amountCents: plan.offset.amountCents, direction, note: 'Settled up both ways', isOffset: true });
        applyAllocations(id, plan.offset[direction], at);
      }
    }
  }

  // 6. Tune the last two external expenses so simplification has something
  // to show: Sam ends up owed exactly what Alex owes (one direct transfer
  // clears both) and Priya what Jordan and Morgan owe together (the owner
  // drops out of the middle entirely).
  const netOf = () =>
    new Map(
      computeBidirectionalBalances(
        shares
          .filter((s) => shareMeta.has(s.id))
          .map((s) => ({
            shareId: s.id,
            counterpartyId: shareMeta.get(s.id)!.person,
            direction: shareMeta.get(s.id)!.direction,
            amountCents: toCents(s.amountCents),
            allocatedCents: toCents(allocated.get(s.id) ?? 0),
          })),
      ).map((b) => [b.personId, b.netCents as number]),
    );
  const before = netOf();
  const net = (k: PersonKey) => before.get(personId[k]) ?? 0;
  const samTopUp = net('alex') + net('sam');
  const priyaTopUp = net('jordan') + net('morgan') + net('priya');
  if (net('alex') <= 0 || net('jordan') + net('morgan') <= 0 || samTopUp <= 0 || priyaTopUp <= 0) {
    throw new Error('Seed balances cannot be arranged for simplification; adjust the seed');
  }
  external('sam', 6, 'Concert tickets for the three of us', samTopUp);
  external('priya', 3, 'Lake house weekend', priyaTopUp);

  // 7. Statements: one import per source per period, rendered as the bank's
  // CSV and parsed back through the real importer path. Rows that would
  // collide on the dedup index are the repeat purchases a user approves with
  // "include anyway".
  const SOURCE_FILE: Record<DemoSource, (end: string) => string> = {
    chase: (end) => `Chase_Activity_${end.replace(/-/g, '')}.CSV`,
    discover: (end) => `Discover-Statement-${end.replace(/-/g, '')}.csv`,
    amex: () => 'activity.csv',
  };
  // One ledger account per CSV source; Chase checking and Amex are linked
  // below, Discover stays CSV-only so the sample statement keeps importing.
  const ledgerAccounts: DemoSeed['ledgerAccounts'] = (['chase', 'discover', 'amex'] as const).map((source, i) => ({
    id: ids.uuid(),
    displayName: { chase: 'Chase checking', discover: 'Discover', amex: 'Amex' }[source],
    csvSource: source,
    csvAccountLabel: null,
    cutoverBasis: source === 'chase' ? ('posted' as const) : ('transaction' as const),
    cutoverDate: null,
    cutoverConfirmedAt: null,
    createdAt: new Date(stamp(today, 119, 11).getTime() + i * 1000),
  }));
  const ledgerOf = (source: DemoSource) => ledgerAccounts.find((l) => l.csvSource === source)!;

  const imports: DemoSeed['imports'] = [];
  const statements: Record<string, string> = {};
  const transactions: DemoSeed['transactions'] = [];
  const seenHash = new Set<string>();
  const toTransaction = (r: RawRow, importId: string | null, offsetMs: number) => {
    const amountCents = r.cents * CENTS_TO_MINOR;
    const hash = dedupHash({ source: r.source, accountLabel: null, date: r.date, amountCents, descriptionRaw: r.description });
    const exempt = seenHash.has(hash);
    seenHash.add(hash);
    const c = category.get(r.id)!;
    // The raised car hire: edited after import, so its hash is the imported
    // amount's, as an inline edit leaves it.
    const raised = r.scripted === 'raised';
    transactions.push({
      id: r.id,
      date: r.date,
      amountCents: raised ? amountCents + RAISED_BY_CENTS * CENTS_TO_MINOR : amountCents,
      descriptionRaw: r.description,
      categoryId: c.id,
      categorySource: c.id ? c.source : null,
      source: r.source,
      importId,
      accountLabel: null,
      dedupHash: hash,
      dedupExempt: exempt,
      merchantNormalized: normalizeMerchant(r.description),
      note: raised ? RAISED_NOTE : null,
      bankAccountId: null,
      providerTransactionId: null,
      providerRaw: null,
      pending: false,
      createdAt: new Date(createdAt(r).getTime() + offsetMs),
    });
  };
  PERIOD_ENDS.forEach((end, period) => {
    for (const source of ['chase', 'discover', 'amex'] as const) {
      const batch = rows
        .filter((r) => r.source === source && periodOf(r.daysAgo) === period)
        .sort((a, b) => b.daysAgo - a.daysAgo || a.id.localeCompare(b.id));
      if (batch.length === 0) continue;
      const imp = {
        id: ids.uuid(),
        source,
        filename: SOURCE_FILE[source](dayToDate(today, end)),
        displayName: defaultImportName(source, batch[0].date, batch[batch.length - 1].date),
        importedAt: importedAt(period),
        rowCount: batch.length,
        ledgerAccountId: ledgerOf(source).id,
      };
      imports.push(imp);
      const csv = renderStatement(source, batch);
      parseBack(csv, source, batch);
      statements[imp.id] = csv;
      batch.forEach((r, i) => toTransaction(r, imp.id, i));
    }
  });
  rows.filter((r) => r.source === 'manual').forEach((r) => toTransaction(r, null, 0));

  // 8. The sample statement: the newest Discover activity, not yet imported.
  const sampleRows = rows
    .filter((r) => r.source === 'discover' && r.daysAgo <= SAMPLE_FROM)
    .sort((a, b) => b.daysAgo - a.daysAgo || a.id.localeCompare(b.id));
  const sampleCsv = renderStatement('discover', sampleRows);
  parseBack(sampleCsv, 'discover', sampleRows);

  // 9. Linked banks (DEMO-SYNC.md). Chase checking and Amex sync after their
  // cutover, the day after their last CSV row. Each account's synthetic feed
  // is every row of its source as the bank reports it; the seed applies it
  // through the real cutover split and planner and writes what a sync
  // writes, then the feed holds one delivery per Sync now press.
  const bank = buildLinkedBanks({
    today, rows, ids, categories, engineRules, categoryId, ledgerAccounts, transactions,
  });

  return {
    today,
    ownerId,
    persons,
    categories,
    rules,
    imports,
    transactions: transactions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    splits,
    splitShares: shares,
    receipts,
    receiptItems,
    receiptItemAssignments: assignments,
    settlements,
    settlementAllocations: allocations,
    statements,
    ledgerAccounts,
    bankCategoryMap: bank.bankCategoryMap,
    bankConnections: bank.bankConnections,
    bankAccounts: bank.bankAccounts,
    ledgerStatements: bank.ledgerStatements,
    syncSkippedRows: bank.syncSkippedRows,
    bankItems: bank.bankItems,
    bankStatements: bank.bankStatements,
    sampleStatement: {
      filename: `Discover-Statement-${today.replace(/-/g, '')}.csv`,
      csv: sampleCsv,
      rowCount: sampleRows.length,
      overlapCount: sampleRows.filter((r) => r.daysAgo >= lastEnd).length,
    },
  };
}

// ---- Linked banks ----

// The bank's own category for a row (Plaid's personal finance category,
// primary level), for the rows no rule matches.
const BANK_CATEGORY_MAP: [string, string][] = [['FOOD_AND_DRINK', 'Dining'], ['TRAVEL', 'Travel']];
function bankCategoryOf(m: Merchant | null): string | null {
  const kind = m?.split?.kind;
  return kind === 'dining' || kind === 'groceries' ? 'FOOD_AND_DRINK' : kind === 'travel' ? 'TRAVEL' : null;
}

const LINKED = [
  {
    source: 'chase' as const, itemId: 'demo-item-chase', institutionId: 'demo_ins_chase', institutionName: 'Chase (demo)',
    providerAccountId: 'demo-acct-chase-checking', name: 'Checking', mask: '4417', type: 'depository', subtype: 'checking',
  },
  {
    source: 'amex' as const, itemId: 'demo-item-amex', institutionId: 'demo_ins_amex', institutionName: 'American Express (demo)',
    providerAccountId: 'demo-acct-amex-card', name: 'Card', mask: '2093', type: 'credit', subtype: 'credit card',
  },
];

function buildLinkedBanks(input: {
  today: string;
  rows: readonly RawRow[];
  ids: Rng;
  categories: DemoSeed['categories'];
  engineRules: CategoryRule[];
  categoryId: Record<string, string>;
  ledgerAccounts: DemoSeed['ledgerAccounts'];
  // Every CSV and manual row; synced rows are appended.
  transactions: DemoSeed['transactions'];
}) {
  const { today, ids, transactions } = input;
  const bankCategoryMap = BANK_CATEGORY_MAP.map(([plaidCategory, name], i) => ({
    plaidCategory,
    categoryId: input.categoryId[name],
    createdAt: new Date(stamp(today, 119, 12).getTime() + i * 1000),
  }));
  const bankCategories = new Map(bankCategoryMap.map((m) => [m.plaidCategory, m.categoryId]));
  const nonSplittable = new Set(input.categories.filter((c) => !c.isSplittable).map((c) => c.id));
  const syncedAt = stamp(today, 1, 23);

  const bankConnections: DemoSeed['bankConnections'] = [];
  const bankAccounts: DemoSeed['bankAccounts'] = [];
  const syncSkippedRows: DemoSeed['syncSkippedRows'] = [];
  const ledgerStatements: DemoSeed['ledgerStatements'] = [];
  const bankItems: SyntheticItem[] = [];
  const bankStatements: DemoSeed['bankStatements'] = {};

  for (const linked of LINKED) {
    const ledger = input.ledgerAccounts.find((l) => l.csvSource === linked.source)!;
    const basis = ledger.cutoverBasis;
    const csv = transactions.filter((t) => t.source === linked.source);
    const cutover = defaultCutover(csv.reduce((max, t) => (t.date > max ? t.date : max), ''))!;
    ledger.cutoverDate = cutover;
    // Linked the evening before the cutover, Chase first: the cards list by
    // link date, and two logins linked at the same instant had no order
    // (2026-11-02: Amex jumped above Chase after a sync).
    ledger.cutoverConfirmedAt = new Date(
      stamp(today, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${cutover}T00:00:00Z`)) / 86_400_000) + 1, 20).getTime() +
        LINKED.indexOf(linked) * 15 * 60_000,
    );

    // As the bank reports a row: Chase checking dates by posting (its CSV
    // too); Amex sends the purchase date and posts a day later. The held
    // purchase arrives two days after its CSV date with no authorized date,
    // as Capital One sends every row.
    // An Amex purchase made yesterday or today posts the same day: the seed
    // syncs at the end of yesterday and nothing posts after it.
    const providerOf = (r: BankRow, pending = false): ProviderTransaction => {
      const held = r.scripted === 'held';
      const lag = held ? 2 : linked.source === 'amex' && r.daysAgo >= 2 ? 1 : 0;
      const posted = dayToDate(today, r.daysAgo - lag);
      const authorized = held ? null : dayToDate(today, r.daysAgo);
      const providerTransactionId = `demo-txn-${r.id}`;
      const bankCategory = r.bankCategory;
      return {
        providerTransactionId,
        providerAccountId: linked.providerAccountId,
        amountCents: r.cents * CENTS_TO_MINOR,
        isoCurrencyCode: 'USD',
        unofficialCurrencyCode: null,
        date: posted,
        authorizedDate: authorized,
        descriptionRaw: r.description,
        pending,
        pendingTransactionId: null,
        bankCategory,
        raw: {
          synthetic: true,
          transaction_id: providerTransactionId,
          account_id: linked.providerAccountId,
          date: posted,
          authorized_date: authorized,
          amount: dollars(r.cents),
          name: r.description,
          pending,
          personal_finance_category: bankCategory ? { primary: bankCategory } : null,
        },
      };
    };
    const history = input.rows
      .filter((r) => r.source === linked.source)
      .map((r) => providerOf({ ...r, bankCategory: bankCategoryOf(r.merchant) }));
    const seeded: SyntheticDelivery = { added: history, modified: [], removed: [] };

    // The cutover split and the planner, as commitAccountSync runs them, over
    // the CSV rows it would read.
    const pairedFrom = addDays(cutover, -3 * MATCH_DAYS);
    const windowEnd = addDays(cutover, BOUNDARY_DAYS + MATCH_DAYS);
    const csvRows = csv
      .filter((t) => t.date >= pairedFrom && t.date < windowEnd)
      .map((t) => ({ date: t.date, amountCents: t.amountCents, description: t.descriptionRaw }));
    const split = splitAtCutover({
      cutover: { date: cutover, basis },
      added: seeded.added,
      modified: [],
      removed: [],
      setAsideIds: new Set(),
      setAsideRows: [],
      csvRows,
    });
    const plan = planSync({
      providerAccountId: linked.providerAccountId,
      added: split.added,
      modified: [],
      removed: [],
      stored: new Map(),
      storedElsewhere: new Set(),
      rules: input.engineRules,
      nonSplittableCategoryIds: nonSplittable,
      bankCategories,
      dateBasis: basis,
    });
    if (plan.kind === 'stop') throw new Error(`Seed sync stopped: ${plan.reason}`);

    const connectionId = ids.uuid();
    const accountId = ids.uuid();
    const rowIdOf = (providerTransactionId: string) => providerTransactionId.slice('demo-txn-'.length);
    for (const p of plan.inserts) {
      transactions.push({
        ...syncedRowValues(p, accountId),
        id: rowIdOf(p.providerTransactionId),
        importId: null,
        accountLabel: null,
        dedupHash: null,
        dedupExempt: false,
        note: null,
        createdAt: syncedAt,
      });
    }
    for (const { row, reason } of split.setAside) {
      syncSkippedRows.push({
        bankAccountId: accountId,
        providerTransactionId: row.providerTransactionId,
        reason,
        ...setAsideValues(row),
        createdAt: syncedAt,
      });
    }

    // The last statement before the cutover, by posted date, as the bank's
    // rows give it: Amex is seeded verified against it, Chase checking is
    // left for the visitor.
    const from = addDays(cutover, -30);
    const to = addDays(cutover, -1);
    const inPeriod = history.filter((t) => !t.pending && t.date >= from && t.date <= to);
    const statement = {
      from,
      to,
      chargesCents: inPeriod.filter((t) => t.amountCents > 0).reduce((n, t) => n + t.amountCents, 0),
      creditsCents: inPeriod.filter((t) => t.amountCents < 0).reduce((n, t) => n - t.amountCents, 0),
    };
    bankStatements[linked.providerAccountId] = statement;
    const verified = linked.source === 'amex';

    if (verified) {
      ledgerStatements.push({
        ledgerAccountId: ledger.id,
        closingDate: statement.to,
        periodStart: statement.from,
        nextClosingDate: null,
        startsNewCycle: false,
        source: 'verification',
        createdAt: new Date(ledger.cutoverConfirmedAt!.getTime() + 3_600_000),
      });
    }
    bankConnections.push({
      id: connectionId,
      provider: 'synthetic',
      providerItemId: linked.itemId,
      institutionId: linked.institutionId,
      institutionName: linked.institutionName,
      accessTokenSealed: syntheticToken(linked.itemId),
      status: 'active',
      healthCheckedAt: syncedAt,
      createdAt: ledger.cutoverConfirmedAt!,
    });
    bankAccounts.push({
      id: accountId,
      connectionId,
      providerAccountId: linked.providerAccountId,
      name: linked.name,
      mask: linked.mask,
      type: linked.type,
      subtype: linked.subtype,
      syncEnabled: true,
      syncCursor: syntheticCursor(today, 0),
      lastSyncedAt: syncedAt,
      ledgerAccountId: ledger.id,
      verifiedAt: verified ? new Date(ledger.cutoverConfirmedAt!.getTime() + 3_600_000) : null,
      verification: verified
        ? {
            statement,
            fetchedChargesCents: statement.chargesCents,
            fetchedCreditsCents: statement.creditsCents,
            excluded: [],
            outcome: 'pass',
          }
        : null,
      // Amex's review stays open for the visitor to answer the held row.
      boundaryReviewedAt: verified ? null : syncedAt,
      createdAt: ledger.cutoverConfirmedAt!,
    });

    bankItems.push({
      itemId: linked.itemId,
      institutionId: linked.institutionId,
      institutionName: linked.institutionName,
      accounts: [
        {
          providerAccountId: linked.providerAccountId,
          persistentAccountId: null,
          name: linked.name,
          officialName: null,
          mask: linked.mask,
          type: linked.type,
          subtype: linked.subtype,
          feed: { seeded, presses: pressesFor(linked.source, today, providerOf, input.rows.find((r) => r.scripted === 'split')!) },
        },
      ],
    });
  }
  return { bankCategoryMap, bankConnections, bankAccounts, syncSkippedRows, ledgerStatements, bankItems, bankStatements };
}

// What each Sync now press brings, all dated today (DEMO-SYNC.md, decision
// C): on Amex, a purchase and a pending dinner; the dinner posting with the
// tip; a refund; then the bank changing the amount of the split flight.
// Chase checking brings one purchase. After these, nothing.
type BankRow = { id: string; daysAgo: number; cents: number; description: string; bankCategory: string | null; scripted?: RawRow['scripted'] };

function pressesFor(
  source: 'chase' | 'amex',
  today: string,
  providerOf: (r: BankRow, pending?: boolean) => ProviderTransaction,
  flight: RawRow,
): SyntheticDelivery[] {
  const row = (id: string, cents: number, description: string, bankCategory: string | null): BankRow => ({
    id: `${today}-${id}`, daysAgo: 0, cents, description, bankCategory,
  });
  const none = { modified: [], removed: [] };
  if (source === 'chase') {
    const card = `${today.slice(5, 7)}/${today.slice(8, 10)}`;
    return [{ added: [providerOf(row('coffee', 645, `DUNKIN #348811 RIVERTON IL                ${card}`, 'FOOD_AND_DRINK'))], ...none }];
  }
  // The dinner: no rule names the bistro, so the bank's category files it.
  const bistro = 'NORTH BRANCH BISTRO  RIVERTON            IL';
  const pending = providerOf(row('dinner', 6_420, bistro, 'FOOD_AND_DRINK'), true);
  const posted = { ...providerOf(row('dinner-posted', 7_704, bistro, 'FOOD_AND_DRINK')), pendingTransactionId: pending.providerTransactionId };
  const groceries = 'WHOLEFDS RVT 10441  RIVERTON            IL';
  // The airline re-prices the split flight (a seat change).
  const changed = providerOf({ ...flight, cents: flight.cents + 3_500, bankCategory: bankCategoryOf(flight.merchant) });
  return [
    { added: [providerOf(row('groceries', 3_187, groceries, 'FOOD_AND_DRINK')), pending], ...none },
    { added: [posted], ...none },
    { added: [providerOf(row('refund', -1_299, groceries, 'FOOD_AND_DRINK'))], ...none },
    { added: [], modified: [changed], removed: [] },
  ];
}

function distributePercents(n: number): number[] {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 100 - base * n ? 1 : 0));
}

// ---- Statement files ----

function renderStatement(source: DemoSource, rows: readonly RawRow[]): string {
  // Banks list newest first.
  const ordered = [...rows].reverse();
  switch (source) {
    case 'chase':
      return [
        'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
        ...ordered.map((r) => {
          const bank = -r.cents; // checking: outflows negative
          return `${bank < 0 ? 'DEBIT' : 'CREDIT'},${usDate(r.date)},"${r.description}",${dollars(bank)},${r.chaseType},,,`;
        }),
      ].join('\n') + '\n';
    case 'discover':
      return [
        'Trans. Date,Post Date,Description,Amount,Category',
        ...ordered.map((r) => `${usDate(r.date)},${usDate(r.date)},"${r.description}",${dollars(r.cents)},"${r.bankCategory}"`),
      ].join('\n') + '\n';
    case 'amex':
      return [
        'Date,Description,Amount',
        ...ordered.map((r) => `${usDate(r.date)},${r.description},${dollars(r.cents)}`),
      ].join('\n') + '\n';
  }
}

// Parse a rendered statement with the app's importer and confirm every row
// comes back exactly as generated.
function parseBack(csv: string, source: DemoSource, rows: readonly RawRow[]): void {
  const detected = detectParser(csv);
  if (!detected.ok || detected.parser.bank !== source) {
    throw new Error(`Rendered ${source} statement was not detected as ${source}`);
  }
  const parsed = detected.parser.parseRows(detected.dataRows).map((p) => parsedTransactionSchema.parse(p));
  const expected = [...rows].reverse();
  if (parsed.length !== expected.length) throw new Error(`${source} statement parsed ${parsed.length} of ${expected.length} rows`);
  parsed.forEach((p, i) => {
    const r = expected[i];
    if (p.date !== r.date || p.amountCents !== r.cents * CENTS_TO_MINOR || p.descriptionRaw !== r.description.trim()) {
      throw new Error(`${source} row ${i} did not round-trip: ${JSON.stringify(p)}`);
    }
  });
}

// ---- Receipts ----

function buildReceipt(
  rng: Rng,
  ids: Rng,
  row: RawRow,
  kind: 'grocery' | 'restaurant',
  participantIds: string[],
  ownerId: string,
  personOrder: string[],
) {
  // Work in cents (receipts print two decimals), scale to minor units after.
  const total = row.cents;
  let subtotal: number;
  let tax: number;
  let tip: number;
  let tipLabel = 'Tip';
  if (kind === 'restaurant') {
    // 10.25% tax and an 18% tip on the subtotal.
    subtotal = Math.floor((total * 10_000) / 12_825);
    tax = Math.floor((subtotal * 1025 + 5000) / 10_000);
    tip = total - subtotal - tax;
  } else {
    const fee = row.merchant!.key === 'weee' ? 499 : 0;
    tipLabel = 'Delivery fee';
    subtotal = Math.floor(((total - fee) * 10_000) / 10_225);
    tax = total - fee - subtotal;
    tip = fee;
  }
  const catalog = kind === 'restaurant' ? RESTAURANT_ITEMS : GROCERY_ITEMS;
  const count = Math.min(
    catalog.length,
    kind === 'restaurant' ? rng.int(3, 6) : rng.int(5, 11),
    Math.max(2, Math.floor(subtotal / 300)),
  );
  const chosen = rng.shuffle(catalog).slice(0, count);
  const weight = chosen.reduce((acc, [, w]) => acc + w, 0);
  const amounts = chosen.map(([, w]) => Math.floor((subtotal * w) / weight));
  let leftover = subtotal - amounts.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % amounts.length, leftover -= 1) amounts[i] += 1;

  const receiptId = ids.uuid();
  const companions = participantIds.filter((id) => id !== ownerId);
  const items = chosen.map(([description], i) => ({
    id: ids.uuid(),
    receiptId,
    position: i,
    description,
    quantity: kind === 'grocery' && rng.chance(0.2) ? 2 : 1,
    amountCents: amounts[i] * CENTS_TO_MINOR,
    createdAt: new Date(0),
  }));
  // Each line: the owner's alone (unassigned), one companion's, or shared.
  const assigned = items.map(() => {
    const r = rng.next();
    if (r < 0.35) return [] as string[];
    if (r < 0.7) return [rng.pick(companions)];
    return [...participantIds];
  });
  for (const c of companions) {
    if (!assigned.some((a) => a.includes(c))) assigned[assigned.length - 1] = [c];
  }
  const resolved = computeItemShares({
    ownerId,
    taxCents: toCents(tax * CENTS_TO_MINOR),
    tipCents: toCents(tip * CENTS_TO_MINOR),
    items: items.map((it, i) => ({ amountCents: toCents(it.amountCents), assigneePersonIds: assigned[i] })),
    personOrder,
  });
  const svg = renderReceiptSvg({
    merchant: row.merchant!.display,
    date: row.date,
    items: items.map((it) => ({ description: it.description, quantity: it.quantity, amountCents: it.amountCents })),
    subtotalCents: subtotal * CENTS_TO_MINOR,
    taxCents: tax * CENTS_TO_MINOR,
    tipCents: tip * CENTS_TO_MINOR,
    totalCents: total * CENTS_TO_MINOR,
    tipLabel,
  });
  return {
    receipt: {
      id: receiptId,
      transactionId: row.id,
      merchantExtracted: row.merchant!.display,
      dateExtracted: row.date,
      subtotalCents: subtotal * CENTS_TO_MINOR,
      taxCents: tax * CENTS_TO_MINOR,
      tipCents: tip * CENTS_TO_MINOR,
      totalCents: total * CENTS_TO_MINOR,
      createdAt: new Date(0),
      image: { pathname: `receipts/demo-${row.id}.svg`, svg },
    },
    items,
    assignments: items.flatMap((it, i) => assigned[i].map((personId) => ({ receiptItemId: it.id, personId }))),
    shares: resolved,
  };
}
