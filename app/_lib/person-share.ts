// The shape of one debt share as /people renders it. Lives here rather than
// in people-list.tsx so the share-detail dialog can consume it without the
// two components importing each other.
import type { SplitMethodDisplay } from '@/app/_lib/schema';

// A single debt share on /people, in either direction, with its settlement
// status. External shares (transactionId null) carry splitId for deletion and
// have no Expenses cross-link.
export type PersonShare = {
  shareId: string;
  splitId: string;
  transactionId: string | null;
  date: string;
  description: string;
  amountCents: number;
  allocatedCents: number;
  outstandingCents: number;
  status: 'outstanding' | 'partial' | 'settled';
  // Detail fields. All null for external splits, which have no backing
  // transaction to read a category, total, or note from.
  category: string | null;
  transactionAmountCents: number | null;
  note: string | null;
  // Friendlier label used when sharing the list; see DebtShareRow.
  merchantLabel: string;
  method: SplitMethodDisplay;
  participantCount: number;
};
