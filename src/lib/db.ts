import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { requiredSecret } from './config';
import { AppError } from './errors';
import type { Actor } from './domain';
const globalDb = globalThis as unknown as { voiceAgentPool?: Pool };
export function pool(): Pool {
  return globalDb.voiceAgentPool ??= new Pool({ connectionString: requiredSecret('DATABASE_URL'),
    max: 5, idleTimeoutMillis: 60000, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
}
export async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool().connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function actorTransaction<T>(actor: Actor, work: (db: PoolClient, member:{role:string;permissions:Record<string,boolean>}) => Promise<T>): Promise<T> {
  return transaction(async db => {
    // Lock the fresh membership row and set the transaction-local audit identity in one round trip.
    const active = await db.query(`SELECT id,coalesce(to_jsonb(w)->>'role','user') AS role,coalesce(to_jsonb(w)->'permissions','{}'::jsonb) AS permissions,set_config('nova.actor_id',$1,true),set_config('nova.actor_alias',$3,true)
      FROM public.va_workers w WHERE id=$1::uuid AND workspace_id=$2::uuid AND active FOR SHARE`, [actor.id, actor.workspaceId, actor.displayName]);
    if (!active.rowCount) throw new AppError('UNAUTHORIZED', 'Please sign in again.', 401);
    return work(db,active.rows[0]);
  });
}
export async function workerRead<T>(actor: Actor, work: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(async db => {
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor.id]);
    return work(db);
  });
}
