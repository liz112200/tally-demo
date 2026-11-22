import type { BillDesign } from './bill-design';

export type ShareSnapshotLine = {
  date: string;
  description: string;
  outstandingCents: number;
  category: string | null;
  carried?: { date: string; previous: number; cash: number; adjustment: number };
};

export type BillSnapshot = {
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
