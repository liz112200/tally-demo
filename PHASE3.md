# Phase 3 candidates

Out of scope for phase 2, captured here so they are neither lost nor built
early.

- **Fuzzy-merchant dedup.** Phase 2 hashes `description_raw` exactly, so a
  re-export whose description differs by whitespace or a trailing store
  number would not dedup. Once phase 3 adds merchant normalization (its
  rules-based categorization reads normalized merchant strings), upgrade
  the dedup hash to key on the normalized merchant instead of the raw
  description.
- **OFX/QFX import.** Phase 2 supports CSV only, for all three banks, on a
  uniform parser interface. OFX (and Chase's Intuit QFX variant, with its
  `<INTU.BID>` extensions) adds an SGML parser that benefits one bank and
  breaks the uniform CSV interface. Deferred so 2.4-2.6 stay parallelizable.
  When it lands, `account_label` becomes reliably non-null from `<ACCTID>`.
- **File identity between preview and confirm.** The import flow parses the
  uploaded file on preview and re-parses on confirm; it does not
  cryptographically verify the file is unchanged between the two submits.
  Acceptable for a single-user app. If the flow ever needs to guarantee the
  confirmed rows match what was previewed, hash the file on preview and
  check it on confirm.
- **Richer import error reporting.** Parsing is all-or-nothing: the first
  row that fails `parsedTransactionSchema` aborts the whole import with a
  single message. A later slice could surface per-row errors and allow a
  partial import of the valid rows, once real parsers make malformed rows a
  realistic case.
- **Zelle payments to/from named people.** The Chase checking export carries
  `Zelle payment from <person>` / `Zelle payment to <person>` rows. That
  pattern maps naturally onto the phase-1 Settlement table (a payment that
  pays down a person's balance, with a direction). Candidate for
  auto-proposing settlements from imported Zelle rows. Not built in phase 2;
  these land as ordinary transactions for now.
- **"Not splittable" / personal transactions.** Rent, payroll, and
  card-to-card transfers (e.g. the Discover e-payment) import as ordinary
  ledger rows. A personal / non-splittable flag or filter to keep them out
  of the split and category views is deferred.
- **Filename-derived account_label.** A bank export can carry the account in
  its filename (e.g. `Chase7811_Activity_...csv` → last-4 `7811`), not in
  the CSV body. Parsers take file text only, so `account_label` is null in
  phase 2. Threading `File.name` into the parser to populate it is deferred
  until multi-account actually matters.
- **Amex parser built on a sparse fixture.** The Amex card is new; its
  fixture is two charge rows only, with no payment, refund, or
  foreign-currency example. The 2.6 parser assumes the credit-card sign
  convention (charges positive, credits negative) but only the positive path
  is verified against real data. The first real Amex payment/refund/credit
  may surface an unhandled case and require a follow-up fix.
