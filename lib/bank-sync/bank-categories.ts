// The bank's own categories that can be mapped to the owner's (BANK-SYNC.md,
// "Bank categories"): Plaid's personal finance categories, primary level.
// Pure. The mapping itself is the owner's data, in bank_category_map.
export const PLAID_CATEGORIES = [
  ['FOOD_AND_DRINK', 'Food and drink'],
  ['GENERAL_MERCHANDISE', 'General merchandise'],
  ['TRANSPORTATION', 'Transportation'],
  ['TRAVEL', 'Travel'],
  ['ENTERTAINMENT', 'Entertainment'],
  ['PERSONAL_CARE', 'Personal care'],
  ['MEDICAL', 'Medical'],
  ['HOME_IMPROVEMENT', 'Home improvement'],
  ['GENERAL_SERVICES', 'General services'],
  ['RENT_AND_UTILITIES', 'Rent and utilities'],
  ['GOVERNMENT_AND_NON_PROFIT', 'Government and non-profit'],
  ['BANK_FEES', 'Bank fees'],
  ['LOAN_PAYMENTS', 'Loan payments (card payments too)'],
  ['TRANSFER_IN', 'Transfers in'],
  ['TRANSFER_OUT', 'Transfers out (a payment to a person too)'],
  ['INCOME', 'Income'],
] as const;

export type PlaidCategory = (typeof PLAID_CATEGORIES)[number][0];

export function isPlaidCategory(value: string): value is PlaidCategory {
  return PLAID_CATEGORIES.some(([key]) => key === value);
}
