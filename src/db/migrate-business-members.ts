import { pool } from '../config/db';

// Standalone, idempotent migration for the business_members table.
//
// migrate.ts re-runs the entire schema.sql as one non-idempotent multi-statement query
// (plain CREATE TABLE, no IF NOT EXISTS on the original tables) - that means it can't be
// safely re-run against an already-provisioned database. This script only touches the new
// business_members table and backfills one 'owner' row per existing business, so it's safe
// to run against a live dev/prod database that already has data.
export async function runBusinessMembersMigration() {
  console.log('[migrate-business-members] Ensuring business_members table exists ...');
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_members (
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role        VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'staff')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, user_id)
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id);
    `);

    console.log('[migrate-business-members] Backfilling owner memberships ...');
    const result = await pool.query(`
      INSERT INTO business_members (business_id, user_id, role)
      SELECT id, owner_id, 'owner' FROM businesses
      ON CONFLICT (business_id, user_id) DO NOTHING
      RETURNING business_id;
    `);
    console.log(`[migrate-business-members] Done. Backfilled ${result.rowCount} owner membership row(s).`);
  } catch (err: any) {
    console.error('[migrate-business-members] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Allow running directly: ts-node src/db/migrate-business-members.ts
if (require.main === module) {
  runBusinessMembersMigration();
}
