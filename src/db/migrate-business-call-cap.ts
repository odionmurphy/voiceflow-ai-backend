import { pool } from '../config/db';
import { PLAN_LIMITS } from '../services/stripe';

export async function runBusinessCallCapMigration() {
  try {
    const result = await pool.query(
      `UPDATE subscriptions
       SET calls_included = $1
       WHERE plan = 'business' AND calls_included > $1`,
      [PLAN_LIMITS.business]
    );
    console.log(`[migrate-business-call-cap] Capped ${result.rowCount ?? 0} subscriptions.`);
  } catch (err) {
    console.error('[migrate-business-call-cap] Failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runBusinessCallCapMigration();
}
