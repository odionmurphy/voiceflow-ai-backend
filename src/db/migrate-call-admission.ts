import { pool } from '../config/db';

export async function runCallAdmissionMigration() {
  try {
    await pool.query(`
      BEGIN;
      ALTER TABLE calls
        ADD COLUMN IF NOT EXISTS twilio_call_sid VARCHAR(64),
        ADD COLUMN IF NOT EXISTS quota_reserved BOOLEAN NOT NULL DEFAULT false;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_twilio_call_sid
        ON calls(twilio_call_sid);

      CREATE OR REPLACE FUNCTION increment_calls_used()
      RETURNS TRIGGER AS $$
      BEGIN
          IF NEW.status = 'completed' AND NOT NEW.quota_reserved THEN
              UPDATE subscriptions
              SET calls_used_this_period = calls_used_this_period + 1
              WHERE business_id = NEW.business_id;
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      COMMIT;
    `);
    console.log('[migrate-call-admission] Done.');
  } catch (err) {
    await pool.query('ROLLBACK').catch((rollbackError) => {
      console.error('[migrate-call-admission] Rollback failed:', rollbackError);
    });
    console.error('[migrate-call-admission] Failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runCallAdmissionMigration();
}
