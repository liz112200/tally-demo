// A synthetic receipt image for the demo, drawn as SVG from the receipt's own
// line items so the picture always agrees with the data beside it.
import { formatCents, toCents } from '../money';

export type ReceiptDrawing = {
  merchant: string;
  date: string; // YYYY-MM-DD
  items: readonly { description: string; quantity: number; amountCents: number }[];
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  tipLabel: string;
};

const WIDTH = 340;
const LINE = 20;

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');

export function renderReceiptSvg(r: ReceiptDrawing): string {
  const lines: { left: string; right?: string; bold?: boolean; center?: boolean }[] = [
    { left: r.merchant.toUpperCase(), bold: true, center: true },
    { left: 'Riverton, IL', center: true },
    { left: r.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1'), center: true },
    { left: '' },
    ...r.items.map((i) => ({
      left: i.quantity > 1 ? `${i.description} x${i.quantity}` : i.description,
      right: formatCents(toCents(i.amountCents)),
    })),
    { left: '' },
    { left: 'Subtotal', right: formatCents(toCents(r.subtotalCents)) },
    { left: 'Tax', right: formatCents(toCents(r.taxCents)) },
    ...(r.tipCents > 0 ? [{ left: r.tipLabel, right: formatCents(toCents(r.tipCents)) }] : []),
    { left: 'TOTAL', right: formatCents(toCents(r.totalCents)), bold: true },
    { left: '' },
    { left: 'Thank you!', center: true },
  ];
  const height = 40 + lines.length * LINE;
  const text = lines
    .map((l, i) => {
      const y = 32 + i * LINE;
      const weight = l.bold ? ' font-weight="700"' : '';
      const left = l.center
        ? `<text x="${WIDTH / 2}" y="${y}" text-anchor="middle"${weight}>${escape(l.left)}</text>`
        : `<text x="24" y="${y}"${weight}>${escape(l.left)}</text>`;
      const right = l.right
        ? `<text x="${WIDTH - 24}" y="${y}" text-anchor="end"${weight}>${escape(l.right)}</text>`
        : '';
      return left + right;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">` +
    `<rect width="100%" height="100%" fill="#fbfaf6"/>` +
    `<g font-family="ui-monospace, Menlo, monospace" font-size="13" fill="#2b2a27">${text}</g>` +
    `</svg>`
  );
}
