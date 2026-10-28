// Reduce a raw bank description to a canonical merchant string that
// categorization rules match against. Best-effort: it strips the noise that
// varies row to row (card-token tails, phone numbers, MM/DD suffixes, a
// trailing state code) and normalizes case and whitespace, so a rule can match
// a stable leading merchant token. It does not attempt perfect merchant
// extraction — trailing city names may remain, which is fine because rules key
// on the merchant token, not the whole string.
//
// The regex set is tuned against the real exports (tests/fixtures-real, private)
// and asserted in normalize.test.ts on synthetic ones of the same shape.
export function normalizeMerchant(description: string): string {
  let s = description.toUpperCase();

  // Card-network tokenization tail, e.g. "...CAAPPLE PAY ENDING IN **** 0083..".
  // The state code is often glued to "APPLE" (CAAPPLE, INAPPLE); the optional
  // two leading letters absorb it. Everything from there on is noise.
  s = s.replace(/\s*[A-Z]{0,2}APPLE PAY ENDING IN.*$/, '');

  // Phone numbers (merchant support lines and 10-digit ACH/originator ids).
  s = s.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ');

  // MM/DD posting-date suffixes (may be glued to the next token, so no \b).
  s = s.replace(/\d{2}\/\d{2}/g, ' ');

  // Collapse whitespace before the trailing-state strip so the state is a
  // clean final token.
  s = s.replace(/\s+/g, ' ').trim();

  // Trailing two-letter state code (e.g. "... WILMINGTON DE" -> "... WILMINGTON").
  s = s.replace(/\s+[A-Z]{2}$/, '').trim();

  return s;
}
