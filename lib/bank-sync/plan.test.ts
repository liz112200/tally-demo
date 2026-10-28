import { describe, it, expect } from 'vitest';
import { describeCounts, planSync, referencedPendingIds, type StoredRow, type SyncPlan } from './plan';
import type { ProviderTransaction } from './provider';

const ACCOUNT = 'acc-checking';

function txn(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTransactionId: 'txn-1',
    providerAccountId: ACCOUNT,
    amountCents: 4_330,
    isoCurrencyCode: 'USD',
    unofficialCurrencyCode: null,
    date: '2026-10-09',
    authorizedDate: '2026-10-08',
    descriptionRaw: 'Starbucks',
    pending: false,
    pendingTransactionId: null,
    raw: { transaction_id: overrides.providerTransactionId ?? 'txn-1' },
    ...overrides,
  };
}

// A stored row matching txn()'s defaults: unchanged when txn() arrives again.
function row(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    rowId: `row-${overrides.providerTransactionId ?? 'txn-1'}`,
    providerTransactionId: 'txn-1',
    pending: false,
    amountCents: 4_330,
    date: '2026-10-08',
    descriptionRaw: 'Starbucks',
    categoryId: 'cat-dining',
    categorySource: 'rule',
    bankAmountBeforeCents: null,
    deleted: false,
    removedByBank: false,
    hasSplit: false,
    hasReceipt: false,
    hasNote: false,
    ...overrides,
  };
}

const removal = (id: string) => ({ providerTransactionId: id, providerAccountId: ACCOUNT });

const RULES = [
  { categoryId: 'cat-dining', matchPattern: 'STARBUCKS', matchType: 'substring' as const, priority: 10, createdAt: '2026-01-01' },
  { categoryId: 'cat-transfers', matchPattern: 'E-PAYMENT', matchType: 'substring' as const, priority: 10, createdAt: '2026-01-01' },
];

function plan(input: Partial<Omit<Parameters<typeof planSync>[0], 'stored'>> & { stored?: StoredRow[] } = {}) {
  const { stored = [], ...rest } = input;
  return planSync({
    providerAccountId: ACCOUNT,
    added: [],
    modified: [],
    removed: [],
    storedElsewhere: new Set(),
    rules: RULES,
    nonSplittableCategoryIds: new Set(['cat-transfers']),
    ...rest,
    stored: new Map(stored.map((r) => [r.providerTransactionId, r])),
  });
}

function applied(result: SyncPlan) {
  if (result.kind !== 'apply') throw new Error(`expected apply, got stop: ${result.reason}`);
  return result;
}

describe('new rows', () => {
  it('posted rows become inserts with the authorized date, normalized merchant, and rule category', () => {
    const result = applied(plan({ added: [txn()] }));
    expect(result.inserts).toEqual([
      {
        providerTransactionId: 'txn-1',
        date: '2026-10-08',
        amountCents: 4_330,
        descriptionRaw: 'Starbucks',
        merchantNormalized: 'STARBUCKS',
        categoryId: 'cat-dining',
        categorySource: 'rule',
        pending: false,
        providerRaw: { transaction_id: 'txn-1' },
      },
    ]);
    expect(result.counts).toMatchObject({ inserted: 1, insertedPending: 0 });
    expect(result.updates).toEqual([]);
  });

  it('use the posted date when the bank gives no authorized date', () => {
    expect(applied(plan({ added: [txn({ authorizedDate: null })] })).inserts[0].date).toBe('2026-10-09');
  });

  it('stay uncategorized when no rule matches', () => {
    expect(applied(plan({ added: [txn({ descriptionRaw: 'KFC' })] })).inserts[0]).toMatchObject({
      categoryId: null,
      categorySource: null,
    });
  });

  it('keep the amount and sign exactly as the provider converted them', () => {
    const result = applied(plan({ added: [txn({ amountCents: -500_000, descriptionRaw: 'REFUND' })] }));
    expect(result.inserts[0].amountCents).toBe(-500_000);
  });

  it('pending rows are stored as pending', () => {
    const result = applied(plan({ added: [txn({ pending: true })] }));
    expect(result.inserts[0].pending).toBe(true);
    expect(result.counts).toMatchObject({ inserted: 1, insertedPending: 1 });
  });

  it('a row repeated in one fetch is inserted once', () => {
    expect(applied(plan({ added: [txn(), txn()] })).inserts).toHaveLength(1);
  });

  it('a stored row delivered again unchanged writes nothing', () => {
    const result = applied(plan({ added: [txn()], stored: [row()] }));
    expect(result.inserts).toEqual([]);
    expect(result.updates).toEqual([]);
  });

  it('an id added and removed in the same fetch is never inserted', () => {
    const result = applied(plan({ added: [txn()], removed: [removal('txn-1')] }));
    expect(result.inserts).toEqual([]);
    expect(result.counts.ignored).toBe(1);
  });

  it('an id added and modified in the same fetch is inserted with the final values', () => {
    const result = applied(plan({ added: [txn()], modified: [txn({ amountCents: 5_000 })] }));
    expect(result.inserts).toHaveLength(1);
    expect(result.inserts[0].amountCents).toBe(5_000);
  });
});

describe('posted takes over pending', () => {
  const pendingRow = row({ providerTransactionId: 'pend-1', pending: true, amountCents: 4_000, categorySource: 'manual', hasNote: true });
  const posted = txn({ providerTransactionId: 'post-1', pendingTransactionId: 'pend-1', amountCents: 4_800 });

  it('updates the pending row in place: new id, amount, posted; note and manual category untouched', () => {
    const result = applied(plan({ added: [posted], removed: [removal('pend-1')], stored: [pendingRow] }));
    expect(result.inserts).toEqual([]);
    expect(result.updates).toEqual([
      {
        rowId: 'row-pend-1',
        reason: 'takeover',
        set: { providerTransactionId: 'post-1', providerRaw: posted.raw, pending: false, amountCents: 4_800 },
      },
    ]);
    // The pending row's own removal is the takeover, not a deletion.
    expect(result.counts).toMatchObject({ takenOver: 1, removedDeleted: 0 });
  });

  it('works when the pending removal arrives in a later sync', () => {
    const result = applied(plan({ added: [posted], stored: [pendingRow] }));
    expect(result.updates.map((u) => u.reason)).toEqual(['takeover']);
    // That later removal names an id no longer stored: ignored.
    expect(applied(plan({ removed: [removal('pend-1')] })).counts.ignored).toBe(1);
  });

  it('revives a pending row the bank already removed', () => {
    const result = applied(
      plan({ added: [posted], stored: [{ ...pendingRow, deleted: true, removedByBank: true }] }),
    );
    expect(result.updates[0].set).toMatchObject({ deletedAt: null, removedByBankAt: null, providerTransactionId: 'post-1' });
  });

  it('leaves a pending row the owner deleted deleted, under its new id', () => {
    const result = applied(plan({ added: [posted], stored: [{ ...pendingRow, deleted: true }] }));
    expect(result.updates[0].set.providerTransactionId).toBe('post-1');
    expect(result.updates[0].set.deletedAt).toBeUndefined();
    expect(result.inserts).toEqual([]);
  });

  it('inserts the posted row when its pending row was never stored', () => {
    const result = applied(plan({ added: [posted] }));
    expect(result.inserts.map((i) => i.providerTransactionId)).toEqual(['post-1']);
    expect(result.updates).toEqual([]);
  });

  it('when the posted id is already stored, removes the live pending row instead of duplicating', () => {
    const result = applied(
      plan({ added: [posted], stored: [pendingRow, row({ providerTransactionId: 'post-1', amountCents: 4_800 })] }),
    );
    expect(result.inserts).toEqual([]);
    expect(result.updates).toEqual([
      { rowId: 'row-pend-1', reason: 'remove-delete', set: { removedByBankAt: 'now', deletedAt: 'now' } },
    ]);
  });

  it('stops when the pending row belongs to another account', () => {
    expect(plan({ added: [posted], storedElsewhere: new Set(['pend-1']) })).toEqual({
      kind: 'stop',
      reason: expect.stringMatching(/pending row of another account/),
    });
  });

  it('re-runs rules on the new description, but never over a manual category', () => {
    const ruled = row({ providerTransactionId: 'pend-1', pending: true, descriptionRaw: 'SQ *PENDING', categoryId: null, categorySource: null });
    const result = applied(plan({ added: [posted], stored: [ruled] }));
    expect(result.updates[0].set).toMatchObject({ categoryId: 'cat-dining', categorySource: 'rule' });
    const manual = applied(plan({ added: [posted], stored: [{ ...ruled, categoryId: 'cat-x', categorySource: 'manual' }] }));
    expect(manual.updates[0].set.categoryId).toBeUndefined();
  });

  it('two posted rows claiming one pending row: the first takes over, the second is inserted', () => {
    const second = txn({ providerTransactionId: 'post-2', pendingTransactionId: 'pend-1' });
    const result = applied(plan({ added: [posted, second], stored: [pendingRow] }));
    expect(result.counts.takenOver).toBe(1);
    expect(result.inserts.map((i) => i.providerTransactionId)).toEqual(['post-2']);
  });
});

describe('modified rows', () => {
  it('apply amount, date and description; a row without a split gets no flag', () => {
    const result = applied(
      plan({
        modified: [txn({ amountCents: 5_000, authorizedDate: '2026-10-07', descriptionRaw: 'Starbucks 123' })],
        stored: [row()],
      }),
    );
    expect(result.updates).toEqual([
      {
        rowId: 'row-txn-1',
        reason: 'modify',
        set: {
          date: '2026-10-07',
          descriptionRaw: 'Starbucks 123',
          merchantNormalized: 'STARBUCKS 123',
          amountCents: 5_000,
          providerRaw: { transaction_id: 'txn-1' },
        },
      },
    ]);
    expect(result.counts).toMatchObject({ updated: 1, amountFlagged: 0 });
  });

  it('on a split row: shares are not the planner\'s to touch; the amount is applied and flagged with the split\'s basis', () => {
    const result = applied(plan({ modified: [txn({ amountCents: 5_000 })], stored: [row({ hasSplit: true })] }));
    expect(result.updates[0].set).toEqual({
      amountCents: 5_000,
      bankAmountBeforeCents: 4_330,
      providerRaw: { transaction_id: 'txn-1' },
    });
    expect(result.counts.amountFlagged).toBe(1);
  });

  it('a second change keeps the first basis', () => {
    const result = applied(
      plan({
        modified: [txn({ amountCents: 6_000 })],
        stored: [row({ hasSplit: true, amountCents: 5_000, bankAmountBeforeCents: 4_330 })],
      }),
    );
    expect(result.updates[0].set.amountCents).toBe(6_000);
    expect(result.updates[0].set.bankAmountBeforeCents).toBeUndefined();
  });

  it('returning to the basis clears the flag', () => {
    const result = applied(
      plan({
        modified: [txn({ amountCents: 4_330 })],
        stored: [row({ hasSplit: true, amountCents: 5_000, bankAmountBeforeCents: 4_330 })],
      }),
    );
    expect(result.updates[0].set).toMatchObject({ amountCents: 4_330, bankAmountBeforeCents: null });
    expect(result.counts.amountFlagged).toBe(0);
  });

  it('a change to a row the owner deleted is applied; the row stays deleted with no flag', () => {
    const result = applied(
      plan({ modified: [txn({ amountCents: 5_000 })], stored: [row({ deleted: true, hasSplit: true })] }),
    );
    expect(result.updates[0].set).toEqual({ amountCents: 5_000, providerRaw: { transaction_id: 'txn-1' } });
  });

  it('a change to an id never stored is ignored', () => {
    const result = applied(plan({ modified: [txn({ providerTransactionId: 'unknown' })] }));
    expect(result).toMatchObject({ inserts: [], updates: [], counts: { ignored: 1 } });
  });

  it('a pending row can change freely', () => {
    const result = applied(
      plan({ modified: [txn({ pending: true, amountCents: 5_200 })], stored: [row({ pending: true })] }),
    );
    expect(result.updates[0].set).toMatchObject({ amountCents: 5_200 });
    expect(result.updates[0].set.bankAmountBeforeCents).toBeUndefined();
  });

  it('a stored posted row reported as pending again stops the sync', () => {
    expect(plan({ modified: [txn({ pending: true })], stored: [row()] })).toEqual({
      kind: 'stop',
      reason: expect.stringMatching(/as pending again/),
    });
  });

  it('rules follow a changed description, but never move a split row into a non-splittable category', () => {
    const toTransfer = txn({ descriptionRaw: 'DISCOVER E-PAYMENT' });
    const plain = applied(plan({ modified: [toTransfer], stored: [row()] }));
    expect(plain.updates[0].set).toMatchObject({ categoryId: 'cat-transfers', categorySource: 'rule' });
    const split = applied(plan({ modified: [toTransfer], stored: [row({ hasSplit: true })] }));
    expect(split.updates[0].set.categoryId).toBeUndefined();
    expect(split.updates[0].set.descriptionRaw).toBe('DISCOVER E-PAYMENT');
  });

  it('a description change that matches no rule clears a rule category, never a manual one', () => {
    const cleared = applied(plan({ modified: [txn({ descriptionRaw: 'KFC' })], stored: [row()] }));
    expect(cleared.updates[0].set).toMatchObject({ categoryId: null, categorySource: null });
    const manual = applied(
      plan({ modified: [txn({ descriptionRaw: 'KFC' })], stored: [row({ categorySource: 'manual' })] }),
    );
    expect(manual.updates[0].set.categoryId).toBeUndefined();
  });
});

describe('removed rows', () => {
  it('a pending row is soft-deleted as the bank\'s', () => {
    const result = applied(
      plan({ removed: [removal('txn-1')], stored: [row({ pending: true, hasNote: true })] }),
    );
    expect(result.updates).toEqual([
      { rowId: 'row-txn-1', reason: 'remove-delete', set: { removedByBankAt: 'now', deletedAt: 'now' } },
    ]);
  });

  it('a posted row the owner built nothing on is soft-deleted as the bank\'s', () => {
    const result = applied(plan({ removed: [removal('txn-1')], stored: [row()] }));
    expect(result.updates[0]).toMatchObject({ reason: 'remove-delete' });
    expect(result.counts.removedDeleted).toBe(1);
  });

  it.each([
    ['a split', { hasSplit: true }],
    ['a receipt', { hasReceipt: true }],
    ['a note', { hasNote: true }],
    ['a manual category', { categorySource: 'manual' as const }],
  ])('a posted row with %s is flagged and stays live', (_label, built) => {
    const result = applied(plan({ removed: [removal('txn-1')], stored: [row(built)] }));
    expect(result.updates).toEqual([{ rowId: 'row-txn-1', reason: 'remove-flag', set: { removedByBankAt: 'now' } }]);
    expect(result.counts.removedFlagged).toBe(1);
  });

  it('an already flagged or deleted row is left alone', () => {
    expect(applied(plan({ removed: [removal('txn-1')], stored: [row({ hasSplit: true, removedByBank: true })] })).updates).toEqual([]);
    expect(applied(plan({ removed: [removal('txn-1')], stored: [row({ deleted: true })] })).updates).toEqual([]);
  });

  it('an id never stored is ignored', () => {
    expect(applied(plan({ removed: [removal('unknown')] })).counts.ignored).toBe(1);
  });

  it('a removal outranks a modification in the same fetch', () => {
    const result = applied(
      plan({ modified: [txn({ amountCents: 9_000 })], removed: [removal('txn-1')], stored: [row({ hasSplit: true })] }),
    );
    expect(result.updates.map((u) => u.reason)).toEqual(['remove-flag']);
  });

  it('the bank re-delivering a row it removed revives it', () => {
    const result = applied(plan({ added: [txn()], stored: [row({ deleted: true, removedByBank: true })] }));
    expect(result.updates[0].set).toMatchObject({ deletedAt: null, removedByBankAt: null });
  });
});

describe('remove and re-add under a new id', () => {
  const split = row({ hasSplit: true, hasReceipt: true });
  const readded = txn({ providerTransactionId: 'txn-new' });

  it('one match on each side: the stored row takes the new id, keeping what was built on it', () => {
    const result = applied(plan({ added: [readded], removed: [removal('txn-1')], stored: [split] }));
    expect(result.inserts).toEqual([]);
    expect(result.updates).toEqual([
      { rowId: 'row-txn-1', reason: 'reidentify', set: { providerTransactionId: 'txn-new', providerRaw: readded.raw } },
    ]);
    expect(result.counts).toMatchObject({ reidentified: 1, removedFlagged: 0, inserted: 0 });
  });

  it('two candidates on the added side: nothing is paired', () => {
    const result = applied(
      plan({
        added: [readded, txn({ providerTransactionId: 'txn-new-2' })],
        removed: [removal('txn-1')],
        stored: [split],
      }),
    );
    expect(result.counts).toMatchObject({ reidentified: 0, removedFlagged: 1, inserted: 2 });
  });

  it('two candidates on the removed side: nothing is paired', () => {
    const result = applied(
      plan({
        added: [readded],
        removed: [removal('txn-1'), removal('txn-2')],
        stored: [split, row({ providerTransactionId: 'txn-2', hasNote: true })],
      }),
    );
    expect(result.counts).toMatchObject({ reidentified: 0, removedFlagged: 2, inserted: 1 });
  });

  it('a different amount, date or description is not a match', () => {
    for (const changed of [{ amountCents: 4_331 }, { authorizedDate: '2026-10-07' }, { descriptionRaw: 'Starbucks #2' }]) {
      const result = applied(
        plan({ added: [txn({ providerTransactionId: 'txn-new', ...changed })], removed: [removal('txn-1')], stored: [split] }),
      );
      expect(result.counts).toMatchObject({ reidentified: 0, removedFlagged: 1, inserted: 1 });
    }
  });
});

describe('rows that must never be guessed at', () => {
  it('stop on a non-USD currency, in added or modified', () => {
    expect(plan({ added: [txn({ isoCurrencyCode: 'VND' })] })).toEqual({
      kind: 'stop',
      reason: expect.stringMatching(/not in USD \(VND\)/),
    });
    expect(plan({ added: [txn({ isoCurrencyCode: null, unofficialCurrencyCode: 'BTC' })] }).kind).toBe('stop');
    expect(plan({ modified: [txn({ isoCurrencyCode: 'EUR' })], stored: [row()] }).kind).toBe('stop');
  });

  it('stop on a row for another account', () => {
    expect(plan({ added: [txn({ providerAccountId: 'acc-other' })] })).toEqual({
      kind: 'stop',
      reason: expect.stringMatching(/another account/),
    });
    expect(plan({ removed: [{ providerTransactionId: 'x', providerAccountId: 'acc-other' }] }).kind).toBe('stop');
  });

  it('stop on a row with no description, pending or posted, added or modified', () => {
    expect(plan({ added: [txn({ descriptionRaw: '  ' })] }).kind).toBe('stop');
    expect(plan({ added: [txn({ descriptionRaw: '', pending: true })] }).kind).toBe('stop');
    expect(plan({ modified: [txn({ descriptionRaw: '' })], stored: [row()] }).kind).toBe('stop');
  });

  it('a stop applies nothing, even rows that were fine', () => {
    const result = plan({ added: [txn(), txn({ providerTransactionId: 'txn-2', isoCurrencyCode: 'EUR' })] });
    expect(result.kind).toBe('stop');
    expect('inserts' in result).toBe(false);
  });
});

describe('referencedPendingIds', () => {
  it('lists each pending id a posted row points at, once', () => {
    expect(
      referencedPendingIds([
        txn({ providerTransactionId: 'a', pendingTransactionId: 'p1' }),
        txn({ providerTransactionId: 'b', pendingTransactionId: 'p1' }),
        txn({ providerTransactionId: 'c', pending: true, pendingTransactionId: 'p2' }),
        txn({ providerTransactionId: 'd' }),
      ]),
    ).toEqual(['p1']);
  });
});

describe('describeCounts', () => {
  const zero = { inserted: 0, insertedPending: 0, takenOver: 0, reidentified: 0, updated: 0, amountFlagged: 0, removedDeleted: 0, removedFlagged: 0, ignored: 0 };
  it('names only what happened', () => {
    expect(describeCounts(zero)).toBe('no changes');
    expect(describeCounts({ ...zero, inserted: 3, insertedPending: 1, takenOver: 2 })).toBe('3 new (1 pending), 2 posted');
    expect(describeCounts({ ...zero, updated: 1, reidentified: 1, removedDeleted: 1, amountFlagged: 1 })).toBe(
      '2 updated, 1 removed by the bank, 1 needs review',
    );
    expect(describeCounts({ ...zero, amountFlagged: 1, removedFlagged: 1 })).toBe('2 need review');
  });
});
