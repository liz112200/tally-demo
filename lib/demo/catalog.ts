// The demo's synthetic merchants. Every name, town, and id here is invented;
// the descriptor formats imitate each bank's export closely enough that the
// real parsers, merchant normalizer, and categorization rules treat them like
// genuine rows. Frequencies follow the shape of a real ledger (per-source
// volume, category mix, split rate), not its amounts.
//
// Amounts are integer CENTS here (bank exports carry two decimals) and are
// scaled to minor units by the builder. Ranges are sampled as the smaller of
// two uniform draws, which skews toward the low end the way card spend does,
// without touching floats.
import type { Rng } from './rng';

export type DemoSource = 'chase' | 'discover' | 'amex';

export type SplitKind = 'dining' | 'groceries' | 'ride' | 'fun' | 'travel' | 'utility';

export type Merchant = {
  key: string;
  source: DemoSource;
  // Expected rows per 30 days.
  perMonth: number;
  // Fixed amounts to choose among, or an inclusive [min, max] range, in
  // cents. Canonical sign: spending positive, credits negative.
  amounts: { fixed: number[] } | { range: [number, number] };
  describe: (rng: Rng) => string;
  // Discover's own category column; Chase's Type column.
  bankCategory?: string;
  chaseType?: string;
  // Category the owner set by hand when no rule matches (else uncategorized).
  manualCategory?: string;
  // Sometimes the owner re-files a rule-categorized row by hand.
  override?: { category: string; p: number };
  // Name printed on a receipt.
  display: string;
  split?: { kind: SplitKind; p: number; receipt?: 'grocery' | 'restaurant' };
};

export const CATEGORY_NAMES = [
  'Groceries',
  'Dining',
  'Transport',
  'Utilities',
  'Entertainment',
  'Shopping',
  'Health',
  'Travel',
  'Subscription',
  'Insurance',
  'Other',
  'Income',
  'Rent',
] as const;

export const NON_SPLITTABLE = ['Income', 'Rent'] as const;

// The categorization rules a visitor finds pre-seeded. The first seven are
// the app's own seed rules; the rest cover the demo merchants.
export const DEMO_RULES: {
  matchPattern: string;
  matchType: 'substring' | 'regex';
  category: string;
  priority: number;
}[] = [
  { matchPattern: 'UBER|LYFT', matchType: 'regex', category: 'Transport', priority: 100 },
  { matchPattern: 'MARATHON', matchType: 'substring', category: 'Transport', priority: 100 },
  { matchPattern: 'HERTZ', matchType: 'substring', category: 'Travel', priority: 100 },
  { matchPattern: 'AMAZON', matchType: 'substring', category: 'Shopping', priority: 100 },
  { matchPattern: 'WALMART', matchType: 'substring', category: 'Shopping', priority: 100 },
  { matchPattern: 'WEEE', matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: 'TST*', matchType: 'substring', category: 'Dining', priority: 100 },
  { matchPattern: 'VENTRA', matchType: 'substring', category: 'Transport', priority: 100 },
  { matchPattern: "TRADER JOE'S", matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: 'WHOLEFDS', matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: 'ALDI', matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: 'COSTCO', matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: '^(SQ \\*|DOORDASH|CHIPOTLE|DUNKIN)', matchType: 'regex', category: 'Dining', priority: 100 },
  { matchPattern: 'SPOTIFY|NETFLIX|YOUTUBE|APPLE\\.COM/BILL', matchType: 'regex', category: 'Subscription', priority: 90 },
  { matchPattern: 'TARGET', matchType: 'substring', category: 'Shopping', priority: 100 },
  { matchPattern: 'AIRBNB|DELTA AIR|UNITED', matchType: 'regex', category: 'Travel', priority: 100 },
  { matchPattern: 'STATE FARM', matchType: 'substring', category: 'Insurance', priority: 100 },
  { matchPattern: 'COMED|XFINITY', matchType: 'regex', category: 'Utilities', priority: 100 },
  { matchPattern: 'AMC ', matchType: 'substring', category: 'Entertainment', priority: 100 },
];

const TOWNS = ['RIVERTON IL', 'OAKDALE IL', 'LAKEVIEW IL', 'BRIDGEPORT IL'] as const;

// Discover appends the Apple Pay token tail glued to the state code.
const applePay = (rng: Rng, base: string) => {
  const town = rng.pick(TOWNS);
  return rng.chance(0.6)
    ? `${base} ${town}APPLE PAY ENDING IN ****`
    : `${base} ${town}`;
};

const digits = (rng: Rng, n: number) =>
  Array.from({ length: n }, () => rng.int(0, 9)).join('');

// Chase debit-card rows end with padded "MM/DD"; the builder fills the date.
export const CHASE_CARD_DATE = '{MMDD}';

export const MERCHANTS: Merchant[] = [
  // ---- Discover (the everyday card) ----
  {
    key: 'ventra', source: 'discover', perMonth: 11, display: 'Ventra',
    amounts: { fixed: [250, 250, 250, 250, 500] },
    describe: (r) => applePay(r, 'VENTRA TRANSIT FARE'), bankCategory: 'Travel/ Entertainment',
  },
  {
    key: 'uber', source: 'discover', perMonth: 5, display: 'Uber',
    amounts: { range: [812, 3290] },
    describe: (r) =>
      `UBER *TRIP 866-576-1039 ${r.chance(0.6) ? 'CAAPPLE PAY ENDING IN ****' : 'CA'}`,
    bankCategory: 'Travel/ Entertainment', split: { kind: 'ride', p: 0.55 },
  },
  {
    key: 'lyft', source: 'discover', perMonth: 2, display: 'Lyft',
    amounts: { range: [950, 2610] },
    describe: (r) => `LYFT *RIDE ${['MON', 'TUE', 'FRI', 'SAT'][r.int(0, 3)]} ${r.int(1, 9)}PM`,
    bankCategory: 'Travel/ Entertainment', split: { kind: 'ride', p: 0.4 },
  },
  {
    key: 'traderjoes', source: 'discover', perMonth: 5, display: "Trader Joe's",
    amounts: { range: [1240, 9680] },
    describe: (r) => applePay(r, `TRADER JOE'S #${r.pick(['552', '718'])}`), bankCategory: 'Supermarkets',
    split: { kind: 'groceries', p: 0.7, receipt: 'grocery' },
  },
  {
    key: 'wholefoods', source: 'discover', perMonth: 2.5, display: 'Whole Foods Market',
    amounts: { range: [1580, 11240] },
    describe: (r) => applePay(r, `WHOLEFDS RVT ${digits(r, 5)}`), bankCategory: 'Supermarkets',
    split: { kind: 'groceries', p: 0.55, receipt: 'grocery' },
  },
  {
    key: 'weee', source: 'discover', perMonth: 2, display: 'Weee!',
    amounts: { range: [3500, 8900] },
    describe: () => 'WEEE INC 510-573-8888 CA', bankCategory: 'Supermarkets',
    split: { kind: 'groceries', p: 0.6, receipt: 'grocery' },
  },
  {
    key: 'aldi', source: 'discover', perMonth: 3, display: 'ALDI',
    amounts: { range: [890, 6420] },
    describe: (r) => applePay(r, `ALDI ${digits(r, 5)}`), bankCategory: 'Supermarkets',
    split: { kind: 'groceries', p: 0.4 },
  },
  {
    key: 'hmart', source: 'discover', perMonth: 1.5, display: 'H Mart',
    amounts: { range: [1820, 7460] },
    describe: (r) => applePay(r, 'H MART RIVERTON'), bankCategory: 'Supermarkets',
    manualCategory: 'Groceries', split: { kind: 'groceries', p: 0.5 },
  },
  {
    key: 'bluedoor', source: 'discover', perMonth: 2, display: 'Blue Door Kitchen',
    amounts: { range: [2240, 9860] },
    describe: (r) => applePay(r, 'TST*BLUE DOOR KITCHEN'), bankCategory: 'Restaurants',
    split: { kind: 'dining', p: 0.85, receipt: 'restaurant' },
  },
  {
    key: 'tacos', source: 'discover', perMonth: 1.5, display: 'Maple Street Tacos',
    amounts: { range: [1460, 5280] },
    describe: (r) => applePay(r, 'TST*MAPLE STREET TACOS'), bankCategory: 'Restaurants',
    split: { kind: 'dining', p: 0.8, receipt: 'restaurant' },
  },
  {
    key: 'sunrise', source: 'discover', perMonth: 2, display: 'Sunrise Cafe',
    amounts: { range: [740, 2860] },
    describe: (r) => applePay(r, 'SQ *SUNRISE CAFE'), bankCategory: 'Restaurants',
    split: { kind: 'dining', p: 0.5 },
  },
  {
    key: 'chipotle', source: 'discover', perMonth: 1.5, display: 'Chipotle',
    amounts: { range: [1085, 2890] },
    describe: (r) => applePay(r, `CHIPOTLE ${digits(r, 4)}`), bankCategory: 'Restaurants',
    split: { kind: 'dining', p: 0.5 },
  },
  {
    key: 'doordash', source: 'discover', perMonth: 1.5, display: 'DoorDash',
    amounts: { range: [2350, 6840] },
    describe: (r) => `DOORDASH*${r.pick(['THAI SPOON', 'PHO HOUSE', 'SLICE BROS'])} SAN FRANCISCO CA`,
    bankCategory: 'Restaurants', split: { kind: 'dining', p: 0.7 },
  },
  {
    key: 'amazon', source: 'discover', perMonth: 3, display: 'Amazon',
    amounts: { range: [899, 8450] },
    describe: (r) => `AMAZON MKTPL*${digits(r, 2)}${r.pick(['K4', 'H8', 'Q2'])}${digits(r, 3)} AMZN.COM/BILLWA`,
    bankCategory: 'Merchandise', override: { category: 'Other', p: 0.3 },
  },
  {
    key: 'target', source: 'discover', perMonth: 1, display: 'Target',
    amounts: { range: [1299, 7820] },
    describe: (r) => applePay(r, `TARGET ${digits(r, 8)}`), bankCategory: 'Merchandise',
    override: { category: 'Groceries', p: 0.4 },
  },
  {
    key: 'walgreens', source: 'discover', perMonth: 1, display: 'Walgreens',
    amounts: { range: [649, 3420] },
    describe: (r) => applePay(r, `WALGREENS #${digits(r, 5)}`), bankCategory: 'Medical Services',
    manualCategory: 'Health',
  },
  {
    key: 'blick', source: 'discover', perMonth: 0.5, display: 'Blick Art Materials',
    amounts: { range: [1850, 6400] },
    describe: (r) => applePay(r, 'BLICK ART MATERIALS'), bankCategory: 'Merchandise',
    manualCategory: 'Shopping',
  },
  {
    key: 'amc', source: 'discover', perMonth: 0.8, display: 'AMC Theatres',
    amounts: { range: [2600, 6400] },
    describe: (r) => `AMC ${digits(r, 4)} ONLINE 913-213-2000 KS`, bankCategory: 'Travel/ Entertainment',
    split: { kind: 'fun', p: 0.85 },
  },
  {
    key: 'spotify', source: 'discover', perMonth: 1, display: 'Spotify',
    amounts: { fixed: [1199] }, describe: () => 'SPOTIFY USA 877-778-1161 NY', bankCategory: 'Services',
  },
  {
    key: 'netflix', source: 'discover', perMonth: 1, display: 'Netflix',
    amounts: { fixed: [1549] }, describe: () => 'NETFLIX.COM 866-579-7172 CA', bankCategory: 'Services',
  },
  {
    key: 'youtube', source: 'discover', perMonth: 1, display: 'YouTube Premium',
    amounts: { fixed: [1399] }, describe: () => 'GOOGLE *YOUTUBEPREMIUM G.CO/HELPPAY#CA', bankCategory: 'Services',
  },
  {
    key: 'amazon-refund', source: 'discover', perMonth: 0.5, display: 'Amazon',
    amounts: { range: [-4200, -899] },
    describe: (r) => `AMAZON MKTPL*${digits(r, 2)}R${digits(r, 4)} AMZN.COM/BILLWA`,
    bankCategory: 'Payments and Credits',
  },

  // ---- Chase checking (debits positive after the parser's sign flip) ----
  {
    key: 'chase-ventra', source: 'chase', perMonth: 8, display: 'Ventra',
    amounts: { fixed: [250, 250, 500] },
    describe: () => `VENTRA TRANSIT FARE 877-669-8368 IL               ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD',
  },
  {
    key: 'marathon', source: 'chase', perMonth: 1, display: 'Marathon',
    amounts: { range: [2640, 4580] },
    describe: (r) => `MARATHON PETRO${digits(r, 6)} RIVERTON IL         ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD',
  },
  {
    key: 'costco', source: 'chase', perMonth: 1, display: 'Costco',
    amounts: { range: [6800, 18900] },
    describe: (r) => `COSTCO WHSE #${digits(r, 4)} OAKDALE IL          ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD', split: { kind: 'groceries', p: 0.7, receipt: 'grocery' },
    override: { category: 'Shopping', p: 0.25 },
  },
  {
    key: 'chase-traderjoes', source: 'chase', perMonth: 1.5, display: "Trader Joe's",
    amounts: { range: [1460, 7240] },
    describe: (r) => `TRADER JOE'S #${r.pick(['552', '718'])} RIVERTON IL         ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD', split: { kind: 'groceries', p: 0.5 },
  },
  {
    key: 'shell', source: 'chase', perMonth: 1, display: 'Shell',
    amounts: { range: [2410, 4820] },
    describe: (r) => `SHELL OIL ${digits(r, 11)} OAKDALE IL       ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD', manualCategory: 'Transport',
  },
  {
    key: 'venmo-out', source: 'chase', perMonth: 2, display: 'Venmo',
    amounts: { range: [1500, 6000] },
    describe: (r) => `VENMO            PAYMENT    ${digits(r, 10)}     WEB ID: 3264681992`,
    chaseType: 'ACH_DEBIT',
  },
  {
    key: 'venmo-in', source: 'chase', perMonth: 1, display: 'Venmo',
    amounts: { range: [-8000, -1200] },
    describe: (r) => `VENMO            CASHOUT    ${digits(r, 10)}     PPD ID: 5264681992`,
    chaseType: 'ACH_CREDIT',
  },
  {
    key: 'paypal', source: 'chase', perMonth: 1, display: 'PayPal',
    amounts: { range: [1299, 5400] },
    describe: (r) => `PAYPAL           INST XFER  ${digits(r, 13)} WEB ID: PAYPALSI77`,
    chaseType: 'ACH_DEBIT',
  },
  {
    key: 'savings', source: 'chase', perMonth: 1, display: 'Savings',
    amounts: { fixed: [20000, 25000, 30000] },
    describe: (r) => `Online Transfer to SAV ...${digits(r, 4)} transaction#: ${digits(r, 11)}`,
    chaseType: 'ACCT_XFER',
  },
  {
    key: 'dunkin', source: 'chase', perMonth: 3.5, display: "Dunkin'",
    amounts: { range: [389, 1240] },
    describe: (r) => `DUNKIN #${digits(r, 6)} RIVERTON IL                ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD',
  },
  {
    key: 'apple', source: 'chase', perMonth: 1, display: 'Apple',
    amounts: { fixed: [299] },
    describe: () => `APPLE.COM/BILL 866-712-7753 CA               ${CHASE_CARD_DATE}`,
    chaseType: 'DEBIT_CARD',
  },
  {
    key: 'atm', source: 'chase', perMonth: 1, display: 'ATM',
    amounts: { fixed: [4000, 6000, 10000] },
    describe: () => `NON-CHASE ATM WITHDRAW ${CHASE_CARD_DATE} RIVERTON IL`,
    chaseType: 'ATM',
  },
  {
    key: 'comed', source: 'chase', perMonth: 1, display: 'ComEd',
    amounts: { range: [6120, 9840] },
    describe: (r) => `COMED            ELECTRIC   ${digits(r, 10)}     WEB ID: ${digits(r, 10)}`,
    chaseType: 'ACH_DEBIT', split: { kind: 'utility', p: 1 },
  },
  {
    key: 'xfinity', source: 'chase', perMonth: 1, display: 'Xfinity',
    amounts: { fixed: [7000] },
    describe: (r) => `XFINITY          INTERNET   ${digits(r, 10)}     WEB ID: ${digits(r, 10)}`,
    chaseType: 'ACH_DEBIT', split: { kind: 'utility', p: 1 },
  },
  {
    key: 'statefarm', source: 'chase', perMonth: 1, display: 'State Farm',
    amounts: { fixed: [1350] },
    describe: (r) => `STATE FARM  RO 27 SFPP       ${digits(r, 10)}     PPD ID: ${digits(r, 10)}`,
    chaseType: 'ACH_DEBIT',
  },
  {
    key: 'rent', source: 'chase', perMonth: 1, display: 'Oakdale Property Mgmt',
    amounts: { fixed: [145000] },
    describe: (r) => `Zelle payment to OAKDALE PROPERTY MGMT JPM99${digits(r, 6)}`,
    chaseType: 'QUICKPAY_DEBIT', manualCategory: 'Rent',
  },
  {
    key: 'payroll', source: 'chase', perMonth: 2.1, display: 'Northwind Labs',
    amounts: { fixed: [-218042] },
    describe: (r) => `NORTHWIND LABS   PAYROLL    PPD ID: ${digits(r, 10)}`,
    chaseType: 'ACH_CREDIT',
  },
  {
    key: 'interest', source: 'chase', perMonth: 1, display: 'Chase',
    amounts: { range: [-412, -38] },
    describe: () => 'INTEREST PAYMENT', chaseType: 'MISC_CREDIT',
  },

  // ---- Amex (travel card, rarely used) ----
  {
    key: 'delta', source: 'amex', perMonth: 0.4, display: 'Delta Air Lines',
    amounts: { range: [18900, 42600] },
    describe: (r) => `DELTA AIR LINES     ATLANTA             GA ${digits(r, 6)}`,
    split: { kind: 'travel', p: 0.6 },
  },
  {
    key: 'hertz', source: 'amex', perMonth: 0.4, display: 'Hertz',
    amounts: { range: [6200, 21400] },
    describe: () => 'HERTZ CAR RENTAL    RIVERTON            IL',
    split: { kind: 'travel', p: 0.6 },
  },
  {
    key: 'airbnb', source: 'amex', perMonth: 0.5, display: 'Airbnb',
    amounts: { range: [24000, 52000] },
    describe: (r) => `AIRBNB * HM${digits(r, 2)}X${digits(r, 3)}Q   AIRBNB.COM          CA`,
    split: { kind: 'travel', p: 1 },
  },
  {
    key: 'amex-wholefoods', source: 'amex', perMonth: 0.8, display: 'Whole Foods Market',
    amounts: { range: [2200, 8800] },
    describe: (r) => `WHOLEFDS RVT ${digits(r, 5)}  RIVERTON            IL`,
  },
];

// Manual entries: cash spending the owner typed in by hand.
export const MANUAL_ENTRIES: { description: string; amountCents: number; category: string | null }[] = [
  { description: 'Farmers market (cash)', amountCents: 2400, category: 'Groceries' },
  { description: 'Movers tip', amountCents: 4000, category: 'Other' },
  { description: 'Haircut', amountCents: 3500, category: 'Health' },
  { description: 'Street fair food', amountCents: 1800, category: 'Dining' },
  { description: 'Laundromat', amountCents: 925, category: 'Other' },
  { description: 'Book swap donation', amountCents: 500, category: null },
  { description: 'Pizza night (cash)', amountCents: 3150, category: 'Dining' },
  { description: 'Parking meter', amountCents: 600, category: 'Transport' },
];

// Receipt line items, as [description, unit cents].
export const GROCERY_ITEMS: [string, number][] = [
  ['Bananas', 129], ['Greek yogurt', 549], ['Sourdough loaf', 499], ['Eggs, dozen', 389],
  ['Baby spinach', 349], ['Chicken thighs', 1187], ['Jasmine rice 5lb', 899], ['Olive oil', 1099],
  ['Oat milk', 429], ['Cheddar block', 629], ['Coffee beans', 1299], ['Avocados, bag', 549],
  ['Frozen dumplings', 799], ['Salmon fillet', 1449], ['Tortilla chips', 349], ['Salsa verde', 379],
  ['Paper towels', 1199], ['Dish soap', 449], ['Strawberries', 499], ['Pasta', 199],
];

export const RESTAURANT_ITEMS: [string, number][] = [
  ['Smash burger', 1650], ['Fish tacos', 1450], ['Caesar salad', 1200], ['Fries to share', 800],
  ['Margherita pizza', 1800], ['Chicken tinga bowl', 1550], ['Elote', 700], ['Horchata', 450],
  ['IPA draft', 800], ['Lemonade', 450], ['Mushroom risotto', 2100], ['Churros', 900],
];
