// The "Needs you" band above the accounts board (2026-11-05): what Tally has
// noticed about its own state that the owner can act on and that is known to
// be outstanding. Pure: the facts in, the worded lines out.
//
// What earns a line is strict, or the band becomes noise: each line names
// something with an action that resolves it, and disappears when the data
// says it is resolved. Never a count for its own sake ("548 transactions"),
// and no "not now": a line hidden by hand would be an omission that looks
// resolved (DEFAULTS.md).
import { statementWords } from './statement-cycles';

export type NeedsYouKind = 'question' | 'problem' | 'trust' | 'task';

export const KIND_LABEL: Record<NeedsYouKind, { glyph: string; label: string }> = {
  question: { glyph: '?', label: 'A question to answer' },
  problem: { glyph: '!', label: 'Something is off' },
  trust: { glyph: 'i', label: 'Not yet trusted' },
  task: { glyph: '+', label: 'A task' },
};

export type NeedsYouItem = {
  key: string;
  kind: NeedsYouKind;
  // Bold, first: where the action is.
  subject: string;
  text: string;
  action: string;
  href: string;
};

type Side = { statedCents: number; listedCents: number };

export type NeedsYouFacts = {
  // Unanswered held possible duplicates, per ledger account.
  held: { ledgerId: string; name: string; count: number }[];
  // Recorded statements whose totals differ from their period's rows.
  disagreements: { ledgerId: string; name: string; kind: 'card' | 'checking'; closingDate: string; charges: Side | null; credits: Side | null }[];
  // Logins the owner must fix (reconnect, consent ended, not syncing), worded
  // by the caller from the same sentences /accounts/logins uses.
  logins: { key: string; subject: string; text: string; action: string; href: string }[];
  // Syncing bank accounts with rows, not yet checked against a statement.
  unverified: { bankAccountId: string; name: string }[];
  // A ledger account's latest recorded statement, when it has no totals.
  withoutTotals: { ledgerId: string; name: string; closingDate: string }[];
  // A statement that closed after the latest recorded one and is not recorded.
  missingStatements: { ledgerId: string; name: string; since: string }[];
  // Ledger accounts with rows and no statement recorded at all.
  noStatements: { ledgerId: string; name: string }[];
  // Split rows the bank changed or removed since (needsReview).
  flaggedRows: number;
  // Rows raised to fold in what someone owed, still offering Move.
  raisedRows: number;
  // Point-out rules and the uncategorized rows each matches (migration 0037).
  pointOut: { ruleId: string; pattern: string; categoryName: string; count: number }[];
};

const ORDER: NeedsYouKind[] = ['question', 'problem', 'trust', 'task'];
const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

export function needsYouItems(
  facts: NeedsYouFacts,
  format: { day: (iso: string) => string; money: (mills: number) => string },
): NeedsYouItem[] {
  const { day, money } = format;
  const items: NeedsYouItem[] = [];
  const account = (id: string, anchor: string) => `/accounts/${id}#${anchor}`;

  for (const h of facts.held) {
    items.push({
      key: `held:${h.ledgerId}`,
      kind: 'question',
      subject: h.name,
      text: `${h.count === 1 ? '1 bank row is' : `${h.count} bank rows are`} held as a possible duplicate of a CSV row. Same purchase, or a different one?`,
      action: 'Answer',
      href: account(h.ledgerId, 'review'),
    });
  }
  for (const d of facts.disagreements) {
    const [out, back] = statementWords(d.kind);
    const side = (s: Side | null, word: string) => {
      if (!s || s.statedCents === s.listedCents) return null;
      const diff = s.listedCents - s.statedCents;
      return `says ${money(s.statedCents)} in ${word}; its rows here total ${money(s.listedCents)}, ${money(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'}`;
    };
    const sides = [side(d.charges, out), side(d.credits, back)].filter(Boolean);
    if (sides.length === 0) continue;
    items.push({
      key: `differs:${d.ledgerId}:${d.closingDate}`,
      kind: 'problem',
      subject: d.name,
      text: `the ${day(d.closingDate)} statement ${sides.join('; and ')}.`,
      action: 'Compare',
      href: account(d.ledgerId, 'periods'),
    });
  }
  for (const l of facts.logins) items.push({ key: `login:${l.key}`, kind: 'problem', subject: l.subject, text: l.text, action: l.action, href: l.href });
  for (const u of facts.unverified) {
    items.push({
      key: `verify:${u.bankAccountId}`,
      kind: 'trust',
      subject: u.name,
      text: 'not checked against a statement, so its synced rows count in no total.',
      action: 'Verify',
      href: `/accounts/verify/${u.bankAccountId}`,
    });
  }
  for (const m of facts.missingStatements) {
    items.push({
      key: `missing:${m.ledgerId}`,
      kind: 'task',
      subject: m.name,
      text: `a statement has closed since the one of ${day(m.since)} and is not recorded.`,
      action: 'Record it',
      href: `/accounts/${m.ledgerId}?record=statement#statements`,
    });
  }
  for (const n of facts.noStatements) {
    items.push({
      key: `nostatement:${n.ledgerId}`,
      kind: 'task',
      subject: n.name,
      text: 'no statement recorded, so its rows have no cycle to sit in.',
      action: 'Record one',
      href: `/accounts/${n.ledgerId}?record=statement#statements`,
    });
  }
  for (const w of facts.withoutTotals) {
    items.push({
      key: `totals:${w.ledgerId}`,
      kind: 'task',
      subject: w.name,
      text: `the ${day(w.closingDate)} statement has no totals recorded, so nothing compares it with its rows.`,
      action: 'Add totals',
      // Opens that statement's form, not the list it sits in (2026-11-11).
      href: `/accounts/${w.ledgerId}?statement=${w.closingDate}#statements`,
    });
  }
  if (facts.flaggedRows > 0) {
    items.push({
      key: 'flagged',
      kind: 'task',
      subject: 'Bank changes',
      text: `${rows(facts.flaggedRows)} you split ${facts.flaggedRows === 1 ? 'was' : 'were'} changed or removed by the bank since.`,
      action: 'Review',
      href: '/expenses?review=flagged',
    });
  }
  if (facts.raisedRows > 0) {
    items.push({
      key: 'raised',
      kind: 'task',
      subject: 'Raised rows',
      text: `${rows(facts.raisedRows)} raised to fold in what someone owed can move that part into an owes-me line.`,
      action: 'Review',
      href: '/expenses?review=raised',
    });
  }
  for (const p of facts.pointOut) {
    if (p.count === 0) continue;
    items.push({
      key: `point:${p.ruleId}`,
      kind: 'task',
      subject: p.categoryName,
      text: `${rows(p.count)} ${p.count === 1 ? 'matches' : 'match'} your "${p.pattern}" rule and ${p.count === 1 ? 'has' : 'have'} no category.`,
      action: 'Sort',
      href: `/expenses?point=${p.ruleId}`,
    });
  }
  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
