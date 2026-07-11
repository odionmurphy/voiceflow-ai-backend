import fs from 'fs';
import path from 'path';
import { pool } from '../config/db';

export async function runMigration() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  console.log('[migrate] Applying schema.sql ...');
  try {
    await pool.query(sql);
    console.log('[migrate] Done. Tables created (or already existed).');
  } catch (err: any) {
    console.error('[migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Allow running directly: ts-node src/db/migrate.ts
if (require.main === module) {
  runMigration();
}
