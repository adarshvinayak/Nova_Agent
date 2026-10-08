import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (process.argv.includes('--local-bootstrap')) await client.query(await readFile(path.resolve('db/bootstrap-local.sql'), 'utf8'));
    await client.query("SELECT pg_advisory_lock(hashtext('voiceagent_schema_migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS public.va_schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(path.resolve('db/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM public.va_schema_migrations WHERE name=$1', [name])).rowCount) continue;
      const sql = await readFile(path.resolve('db/migrations', name), 'utf8');
      const escaped = name.replaceAll("'", "''");
      await client.query(sql.replace(/COMMIT;\s*$/, `INSERT INTO public.va_schema_migrations(name) VALUES ('${escaped}');\nCOMMIT;`));
      console.log(`Applied ${name}`);
    }
  } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
