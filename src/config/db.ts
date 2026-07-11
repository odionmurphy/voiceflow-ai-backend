import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn('[db] DATABASE_URL is not set - falling back to default local connection');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voiceflow_ai',
  // Most managed Postgres providers (Render, Supabase, Neon) require SSL in production
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] Unexpected error on idle client', err);
});

export async function query<T = any>(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[db]', { text, duration, rows: res.rowCount });
  }
  return res;
}

// Runs `fn` inside a BEGIN/COMMIT transaction on a dedicated client, rolling back on error.
// Needed for multi-insert flows (e.g. creating a business + its ai_settings + subscription +
// membership row) where a partial failure must not leave orphaned/inconsistent rows.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
