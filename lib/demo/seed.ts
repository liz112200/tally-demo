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
  categories: { id: string; name: string; isSplittable: boolean; createdAt: Date }[];
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
  }[];
  transactions: {
    id: string;
    date: string;
    amountCents: number;
    descriptionRaw: string;
    categoryId: string | null;
    categorySource: 'manual' | 'rule' | null;
    source: DemoSource | 'manual';
    importId: string | null;
    accountLabel: null;
    dedupHash: string;
    dedupExempt: boolean;
    merchantNormalized: string;
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
    .filter((r) => inLedger(r) && r.source !== 'manual' && r.cents > 0 && r.merchant?.split)
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
    transactions.push({
      id: r.id,
      date: r.date,
      amountCents,
      descriptionRaw: r.description,
      categoryId: c.id,
      categorySource: c.id ? c.source : null,
      source: r.source,
      importId,
      accountLabel: null,
      dedupHash: hash,
      dedupExempt: exempt,
      merchantNormalized: normalizeMerchant(r.description),
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
    sampleStatement: {
      filename: `Discover-Statement-${today.replace(/-/g, '')}.csv`,
      csv: sampleCsv,
      rowCount: sampleRows.length,
      overlapCount: sampleRows.filter((r) => r.daysAgo >= lastEnd).length,
    },
  };
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
