import { pool } from '../config/db';

export async function runWebsiteWidgetMigration() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS widget_leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(254),
        phone VARCHAR(32),
        message TEXT NOT NULL,
        consent_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE widget_leads
        ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
      UPDATE widget_leads SET consent_at = created_at WHERE consent_at IS NULL;
      ALTER TABLE widget_leads ALTER COLUMN consent_at SET NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_widget_leads_business_created
        ON widget_leads(business_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS widget_booking_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        consent_version VARCHAR(40) NOT NULL,
        website_origin TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_widget_booking_consents_appointment
        ON widget_booking_consents(appointment_id);

      CREATE TABLE IF NOT EXISTS widget_rate_limits (
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        ip_hash CHAR(64) NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, ip_hash, window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_widget_rate_limits_window
        ON widget_rate_limits(window_start);
    `);
    console.log('[migrate-website-widget] Done.');
  } catch (err) {
    console.error('[migrate-website-widget] Failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runWebsiteWidgetMigration();
}
