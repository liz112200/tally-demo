import { sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';

// Give Alex a sample bill dated just before the seeded Zelle payment. Rebuild
// that day's open lines and allocation baselines without changing the ledger.
// Called only after demo-store verification or while writing a fresh test seed.
export async function addDemoBillExample(connection: Pick<ReturnType<typeof drizzle>, 'execute'>) {
  await connection.execute(sql`
    WITH sample AS (
      SELECT s.id, p.id AS person, p.name, s.created_at - interval '1 second' AS at
      FROM settlements s JOIN persons p ON p.id = s.person_id
      WHERE p.name = 'Alex' AND s.note = 'Zelle' AND s.direction = 'incoming'
      ORDER BY s.created_at DESC, s.id LIMIT 1
    ), entries AS (
      SELECT sample.*, ss.id AS share, t.date, COALESCE(NULLIF(t.merchant_normalized,''), t.description_raw) AS description,
        c.name AS category, ss.amount_cents - a.allocated AS due, a.allocated, a.cash
      FROM sample JOIN split_shares ss ON ss.person_id = sample.person
      JOIN splits sp ON sp.id = ss.split_id JOIN persons payer ON payer.id = sp.payer_person_id AND payer.is_owner
      JOIN transactions t ON t.id = sp.transaction_id AND t.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = t.category_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(sa.amount_cents),0) AS allocated,
          COALESCE(sum(sa.amount_cents) FILTER (WHERE NOT st.is_offset),0) AS cash
        FROM settlement_allocations sa JOIN settlements st ON st.id = sa.settlement_id
        WHERE sa.split_share_id = ss.id AND sa.created_at <= sample.at
      ) a
      WHERE sp.created_at <= sample.at AND t.date <= sample.at::date AND ss.amount_cents > a.allocated
    )
    INSERT INTO share_links (id, token, person_name, direction, total_cents, lines, created_at, review_person_id, review_sources)
    SELECT id, ${randomBytes(12).toString('base64url')}, name, 'they-owe-me', sum(due),
      jsonb_agg(jsonb_build_object('date',date,'description',description,'category',category,'outstandingCents',due) ORDER BY date DESC, share),
      at, person, jsonb_agg(jsonb_build_object('shareId',share,'cash',cash,'allocated',allocated) ORDER BY date DESC, share)
    FROM entries GROUP BY id, name, at, person ON CONFLICT (id) DO NOTHING
  `);
}
