import type { BillDesign } from './bill-design';

export type ShareSnapshotLine = {
  date: string;
  description: string;
  outstandingCents: number;
  category: string | null;
  pickedPayment?: number;
  carried?: { date: string; previous: number; cash: number; adjustment: number };
};

// Recipient-facing figures frozen when the owner creates a link.
export type PreviousBalance = {
  date: string;
  token?: string;
  side: 'owed' | 'owing';
  previous: number;
  partialSource?: boolean;
  payments: number;
  paymentDetails?: { date: string; amount: number }[];
  adjustments: number;
  omitted: number;
  included: number;
  assigned: { description: string; date: string; paid: number; remaining?: number }[];
};

export type BillSnapshot = {
  previousBalances?: PreviousBalance[];
  paper: BillDesign;
  personName: string;
  groupedByCategory: boolean;
  createdAt: Date;
  // What the person owes the owner.
  owedCents: number;
  owed: ShareSnapshotLine[];
  // What the owner owes the person.
  owingCents: number;
  owing: ShareSnapshotLine[];
  // owedCents - owingCents; positive means the person owes the owner.
  netCents: number;
};

// Figures belong to the snapshot. Links follow the current revocation state
// of the original bill, including when it is turned off after publication.
export async function availablePreviousBalances(
  groups: PreviousBalance[] | null,
  activeTokens: (tokens: string[]) => Promise<{ token: string }[]>,
) {
  if (!groups?.length) return groups ?? undefined;
  const tokens = [...new Set(groups.flatMap(group => group.token ? [group.token] : []))];
  if (!tokens.length) return groups;
  const active = new Set((await activeTokens(tokens)).map(row => row.token));
  return groups.map(group => group.token && !active.has(group.token) ? { ...group, token: undefined } : group);
}
