-- The demo's synthetic bank provider (DEMO-SYNC.md, slice 8). Adds an enum
-- value; writes no row. Production never holds a synthetic connection: the
-- app opens one only in demo mode.
ALTER TYPE "public"."bank_provider" ADD VALUE 'synthetic';