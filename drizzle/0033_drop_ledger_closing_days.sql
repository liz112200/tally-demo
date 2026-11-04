-- The typed closing day (migration 0031), replaced by recorded statements
-- (0032, STATEMENT-CYCLES.md). Never used: it held no rows on production or
-- the demo when dropped. Run after the code that stopped reading it deployed.
DROP TABLE "ledger_closing_days" CASCADE;