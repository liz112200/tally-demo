// One line per bank flag that was cleared (bank_flag_resolutions, migration
// 0036), for a row's detail: what the bank did, and what was done about it.
// Pure; the caller formats money and days.

export type FlagHistoryItem = {
  flag: 'amount' | 'removed';
  bankAmountBeforeCents: number | null;
  amountCents: number;
  removedByBankAt: string | null;
  resolution: 'kept' | 'split_resaved' | 'split_removed' | 'row_deleted' | 'moved_to_replacement' | 'bank_reverted' | 'unlabelled';
  resolvedAt: string;
};

const DONE: Record<FlagHistoryItem['resolution'], string> = {
  kept: 'kept as it was',
  split_resaved: 'split saved again',
  split_removed: 'split removed',
  row_deleted: 'row deleted',
  moved_to_replacement: 'moved onto the re-sent row',
  bank_reverted: 'the bank changed it back',
  unlabelled: 'mark cleared',
};

export function flagHistoryLine(item: FlagHistoryItem, money: (mills: number) => string, day: (iso: string) => string): string {
  // The bank undoing its own change has no before and after to state.
  if (item.resolution === 'bank_reverted') {
    return item.flag === 'amount'
      ? `The bank changed the amount away from ${money(item.bankAmountBeforeCents!)}, then back on ${day(item.resolvedAt)}.`
      : `The bank removed this row on ${day(item.removedByBankAt!)}, then sent it again on ${day(item.resolvedAt)}.`;
  }
  const what =
    item.flag === 'amount'
      ? `The bank changed the amount from ${money(item.bankAmountBeforeCents!)} to ${money(item.amountCents)}`
      : `The bank removed this row on ${day(item.removedByBankAt!)}`;
  return `${what}; ${DONE[item.resolution]} on ${day(item.resolvedAt)}.`;
}
