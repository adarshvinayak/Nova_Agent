import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
const workspace = '10000000-0000-4000-8000-000000000001';
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (process.env.APP_MODE !== 'demo') throw new Error('Synthetic seed requires APP_MODE=demo');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO va_workspaces(id,name,time_zone) VALUES($1,'Voice Agent Demo','Asia/Dubai') ON CONFLICT(id) DO NOTHING", [workspace]);
    for (const [id, name, email] of [
      ['20000000-0000-4000-8000-000000000001', 'Ava Morgan', 'ava@demo.local'],
      ['20000000-0000-4000-8000-000000000002', 'Omar Hassan', 'omar@demo.local'],
    ]) {
      await client.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [id, workspace, email, name]);
    }
    await client.query(`INSERT INTO private.va_calendar_connections(id,workspace_id,calendar_id,calendar_label,provider,status)
      VALUES('30000000-0000-4000-8000-000000000001',$1,'demo-calendar','Pilot appointments (simulated)','simulated','connected') ON CONFLICT(id) DO NOTHING`, [workspace]);
    await client.query('COMMIT');
    console.log('Synthetic demo workspace and two workers are ready.');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Seed failed'); process.exitCode = 1; });
