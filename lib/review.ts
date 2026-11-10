// Whether a review still applies (migration 0037, ACCOUNTS-BOARD.md). Pure.
//
// A review applies only to the difference it accepted. Once either side
// moves, by a cent, it lapses and the difference is raised again. This is the
// condition the whole review state rests on: a review that survived its
// figures changing would accept a number nobody looked at, which is a
// dismissal (DEFAULTS.md). Do not relax it to a tolerance or to "same sign".
export function reviewApplies(
  review: { chargesDiffCents: number; creditsDiffCents: number } | undefined,
  diff: { chargesDiff: number; creditsDiff: number },
): boolean {
  return review !== undefined && review.chargesDiffCents === diff.chargesDiff && review.creditsDiffCents === diff.creditsDiff;
}
