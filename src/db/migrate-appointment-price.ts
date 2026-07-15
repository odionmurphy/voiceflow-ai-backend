import { pool } from '../config/db';

// Standalone, idempotent migration: adds appointments.price (Phase 4 revenue tracking).
// Safe to re-run against a live dev/prod database - ADD COLUMN IF NOT EXISTS is a no-op
// if it's already there.
export async function runAppointmentPriceMigration() {
  console.log('[migrate-appointment-price] Ensuring appointments.price column exists ...');
  try {
    await pool.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);
    `);
    console.log('[migrate-appointment-price] Done.');
  } catch (err: any) {
    console.error('[migrate-appointment-price] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Allow running directly: ts-node src/db/migrate-appointment-price.ts
if (require.main === module) {
  runAppointmentPriceMigration();
}
