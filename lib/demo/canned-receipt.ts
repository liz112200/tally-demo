// Simulated receipt extraction for the public demo. The real path sends
// images to Gemini on a free tier of 20 requests a day, which a public demo
// would exhaust in minutes, so the demo never calls it: any image "extracts"
// to this dinner receipt, sized to the transaction so the review step lands
// without a total mismatch and the item-assignment step is fully usable.
//
// Same output contract as the model: integer CENTS (hundredths), which the
// upload action scales to minor units exactly as it does real extractions.
import { extractionSchema, type Extraction } from '../receipt/extract';

export const CANNED_MERCHANT = 'Blue Door Kitchen (sample)';

// Menu lines with their relative prices; amounts scale to the receipt.
export const CANNED_ITEMS: [string, number][] = [
  ['Smash burger', 1650],
  ['Fish tacos', 1450],
  ['Caesar salad', 1200],
  ['Fries to share', 800],
  ['IPA draft', 800],
  ['Lemonade', 450],
];

// totalCents: the transaction amount in cents. 10.25% tax and an 18% tip on
// the subtotal; lines take the subtotal in proportion to their menu price,
// leftover cents to the first lines, so everything sums exactly.
export function cannedExtraction(totalCents: number): Extraction {
  const total = Math.max(0, Math.floor(totalCents));
  const lines = total < 2_000 ? CANNED_ITEMS.slice(0, 2) : total < 6_000 ? CANNED_ITEMS.slice(0, 4) : CANNED_ITEMS;
  const subtotal = Math.floor((total * 10_000) / 12_825);
  const tax = Math.floor((subtotal * 1025 + 5000) / 10_000);
  const tip = total - subtotal - tax;
  const weight = lines.reduce((acc, [, w]) => acc + w, 0);
  const amounts = lines.map(([, w]) => Math.floor((subtotal * w) / weight));
  let leftover = subtotal - amounts.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % amounts.length, leftover -= 1) amounts[i] += 1;
  return extractionSchema.parse({
    merchant: CANNED_MERCHANT,
    date: null,
    items: lines.map(([description], i) => ({ description, quantity: 1, amount_cents: amounts[i] })),
    subtotal_cents: subtotal,
    tax_cents: tax,
    tip_cents: tip,
    total_cents: total,
  });
}
