// Which results on the page result line fade by themselves (2026-11-06). The
// October rule stands for anything that carries figures: a result stays until
// replaced or dismissed, because one that vanishes before it is read is worse
// than one that lingers. A confirmation of something just done whose effect
// is on screen ("Kept out: the same purchase as the CSV row.") carries no
// figures, and fades. Errors and warnings never fade. Pure.

export const FADE_AFTER_MS = 5_000;

export function fadesAway(message: { kind: 'error' | 'warning' | 'success'; text: string; details?: string[] }): boolean {
  if (message.kind !== 'success') return false;
  // Any digit is a figure: a count, an amount, a date.
  return !/\d/.test([message.text, ...(message.details ?? [])].join(' '));
}
