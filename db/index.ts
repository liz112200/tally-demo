import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { assertSafeEnvironment } from '@/lib/deploy-guard';

// Before any connection exists: a demo deployment holding production
// credentials fails every request here rather than reaching the database.
assertSafeEnvironment(process.env, 'connect to the database');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// prepare: false is required behind a transaction-pooling endpoint (Neon's
// pooled connection), which does not support prepared statements.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
