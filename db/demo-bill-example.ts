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
  // A pre-tracking bill with one original label and one shorter receipt label.
  const legacyId = sql`md5(person::text || 'older-bill-example')`;
  const exampleId = sql`overlay(overlay(${legacyId} placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid`;
  await connection.execute(sql`
    WITH expenses AS (
      SELECT p.id AS person, p.name, COALESCE(t.date,sp.date) AS date, ss.id, payer.is_owner AS owed,
        COALESCE(NULLIF(t.merchant_normalized,''), sp.description, t.description_raw) AS label,
        ss.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM settlement_allocations a WHERE a.split_share_id=ss.id),0) AS due
      FROM split_shares ss JOIN splits sp ON sp.id=ss.split_id
      JOIN persons payer ON payer.id=sp.payer_person_id JOIN persons participant ON participant.id=ss.person_id
      JOIN persons p ON p.id=CASE WHEN payer.is_owner THEN participant.id ELSE payer.id END
      LEFT JOIN transactions t ON t.id=sp.transaction_id
      WHERE p.name='Priya' AND payer.is_owner <> participant.is_owner AND t.deleted_at IS NULL AND sp.created_at <= now()
    ), examples AS (
      SELECT *, row_number() OVER (ORDER BY owed DESC,date DESC,id) AS n FROM expenses WHERE due>0
      ORDER BY owed DESC,date DESC,id LIMIT 2
    ), receipt AS (
      SELECT *, jsonb_build_object('date',date,'description',CASE WHEN n=1 THEN label ELSE 'Shared expense' END,
        'category',NULL,'outstandingCents',due) AS line FROM examples
    )
    INSERT INTO share_links (id,token,person_name,direction,total_cents,lines,owing_cents,owing_lines)
    SELECT ${exampleId}, ${randomBytes(12).toString('base64url')},
      name,CASE WHEN sum(CASE WHEN owed THEN due ELSE -due END)>=0 THEN 'they-owe-me' ELSE 'i-owe-them' END,
      COALESCE(sum(due) FILTER (WHERE owed),0), COALESCE(jsonb_agg(line ORDER BY n) FILTER (WHERE owed),'[]'),
      COALESCE(sum(due) FILTER (WHERE NOT owed),0), COALESCE(jsonb_agg(line ORDER BY n) FILTER (WHERE NOT owed),'[]')
    FROM receipt GROUP BY person,name HAVING count(*)=2 ON CONFLICT (id) DO NOTHING
  `);
}
