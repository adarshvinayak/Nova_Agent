import pg from 'pg';
import dotenv from 'dotenv';
import { applyRetention } from './retention-core';
dotenv.config({ path: '.env.local', quiet: true });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: retention.ts [--apply]. Default is a rolled-back dry run.');
  const apply = args.includes('--apply');
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await connection.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const counts = await applyRetention(db);
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run-rolled-back', counts }, null, 2));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); await connection.end(); }
}
main().catch(() => { console.error('Retention failed; transaction rolled back. Inspect database permissions/schema and retry.'); process.exitCode = 1; });
