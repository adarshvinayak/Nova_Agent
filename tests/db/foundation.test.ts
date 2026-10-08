import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('PostgreSQL storage invariants (real database)', () => {
  let db: pg.Client;
  const workspace = randomUUID();
  const worker = randomUUID();
  const other = randomUUID();
  const hash = 'a'.repeat(64);

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes('test')) throw new Error('Use a disposable database with test in its name');
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query('DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await db.query(await readFile(path.resolve('db/bootstrap-local.sql'), 'utf8'));
    for (const name of (await readdir(path.resolve('db/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      await db.query(await readFile(path.resolve('db/migrations', name), 'utf8'));
    }
    await db.query('INSERT INTO va_workspaces(id,name) VALUES($1,$2)', [workspace, 'Test']);
    await db.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$3,$4,$4),($2,$3,$5,$5)', [worker, other, workspace, 'one@example.test', 'two@example.test']);
  }, 30000);
  afterAll(async () => { await db?.end(); });

  async function proposal(actor = worker, calendar = randomUUID(), start = '2030-01-01T10:00:00Z', end = '2030-01-01T11:00:00Z') {
    const session = randomUUID(); const id = randomUUID();
    await db.query('INSERT INTO va_sessions(id,workspace_id,worker_id) VALUES($1,$2,$3)', [session, workspace, actor]);
    await db.query(`INSERT INTO va_proposals(id,workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,$5,$6,$7,$8,$9,now()+interval '5 minutes')`, [id, workspace, actor, session, calendar, { title: 'Visit' }, hash, start, end]);
    return { id, session, actor, calendar, start, end };
  }
  async function attempt(p: Awaited<ReturnType<typeof proposal>>, client = db) {
    const id = randomUUID();
    await client.query(`INSERT INTO va_attempts(id,workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at)
      VALUES($1::uuid,$2,$3,$4,$5,$1::uuid::text,$6,$7,$8,$9,$10)`, [id, workspace, p.actor, p.session, p.id, hash, p.calendar, `vc${id.replaceAll('-', '')}`, p.start, p.end]);
    return id;
  }
  async function readAs(actor: string, sql: string, values: unknown[] = []) {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]);
      return await db.query(sql, values);
    } finally { await db.query('ROLLBACK'); }
  }

  it('defaults to Dubai and denies cross-worker links', async () => {
    expect((await db.query('SELECT time_zone FROM va_workspaces WHERE id=$1', [workspace])).rows[0].time_zone).toBe('Asia/Dubai');
    const p = await proposal();
    await expect(db.query(`INSERT INTO va_turns(workspace_id,worker_id,session_id,turn_no,speaker,body) VALUES($1,$2,$3,1,'user','hello')`, [workspace, other, p.session])).rejects.toMatchObject({ code: '23503' });
  });

  it('RLS returns only owned rows; disabled membership loses content access', async () => {
    const mine = await proposal(); const theirs = await proposal(other);
    const result = await readAs(worker, 'SELECT id FROM va_sessions WHERE id=ANY($1::uuid[])', [[mine.session, theirs.session]]);
    expect(result.rows.map(r => r.id)).toEqual([mine.session]);
    await db.query('UPDATE va_workers SET active=false WHERE id=$1', [worker]);
    try { expect((await readAs(worker, 'SELECT id FROM va_sessions')).rowCount).toBe(0); }
    finally { await db.query('UPDATE va_workers SET active=true WHERE id=$1', [worker]); }
  });

  it('authenticated workers cannot mutate public tables or read secrets', async () => {
    await expect(readAs(worker, "UPDATE va_sessions SET facts='{}'")).rejects.toMatchObject({ code: '42501' });
    await expect(readAs(worker, 'SELECT * FROM private.va_calendar_connections')).rejects.toMatchObject({ code: '42501' });
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE anon');
      await expect(db.query('SELECT * FROM public.va_workers')).rejects.toMatchObject({ code: '42501' });
    } finally { await db.query('ROLLBACK'); }
  });

  it('freezes proposal contents and blocks redaction while outcome is unknown', async () => {
    const p = await proposal(); const id = await attempt(p);
    await expect(db.query("UPDATE va_proposals SET snapshot='{}' WHERE id=$1", [p.id])).rejects.toThrow('snapshot is immutable');
    await expect(db.query("UPDATE va_proposals SET starts_at=starts_at+interval '1 minute' WHERE id=$1", [p.id])).rejects.toThrow('identity is immutable');
    await db.query("UPDATE va_proposals SET status='consumed' WHERE id=$1", [p.id]);
    await db.query("UPDATE va_attempts SET status='writing',dispatch_at=now() WHERE id=$1", [id]);
    await db.query("UPDATE va_attempts SET status='unknown' WHERE id=$1", [id]);
    await expect(db.query("UPDATE va_proposals SET snapshot='{}',content_redacted_at=now() WHERE id=$1", [p.id])).rejects.toThrow('snapshot is immutable');
    await db.query("UPDATE va_attempts SET status='failed',resolved_at=now() WHERE id=$1", [id]);
    await db.query("UPDATE va_proposals SET snapshot='{}',content_redacted_at=now() WHERE id=$1", [p.id]);
    expect((await db.query('SELECT snapshot FROM va_proposals WHERE id=$1', [p.id])).rows[0].snapshot).toEqual({});
  });

  it('rejects altered event identity and proposal binding', async () => {
    const p = await proposal(); const id = await attempt(p);
    await expect(db.query("UPDATE va_attempts SET intent_hash=$2 WHERE id=$1", [id, 'b'.repeat(64)])).rejects.toThrow('identity is immutable');
    const next = await proposal(); const nextId = randomUUID();
    await expect(db.query(`INSERT INTO va_attempts(id,workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at)
      VALUES($1::uuid,$2,$3,$4,$5,$1::uuid::text,$6,$7,$8,$9,$10)`, [nextId, workspace, worker, next.session, next.id, hash, next.calendar, `vc${randomUUID().replaceAll('-', '')}`, next.start, next.end])).rejects.toThrow('event ID must derive');
  });

  it('holds unknown intervals, permits adjacent intervals, and only definite failure releases them', async () => {
    const calendar = randomUUID(); const first = await proposal(worker, calendar); const id = await attempt(first);
    await db.query("UPDATE va_attempts SET status='writing',dispatch_at=now() WHERE id=$1", [id]);
    await db.query("UPDATE va_attempts SET status='unknown' WHERE id=$1", [id]);
    const clash = await proposal(other, calendar);
    await expect(attempt(clash)).rejects.toMatchObject({ code: '23P01' });
    await attempt(await proposal(other, calendar, '2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z'));
    await db.query("UPDATE va_attempts SET status='failed',resolved_at=now() WHERE id=$1", [id]);
    await attempt(clash);
  });

  it('serializes concurrent overlapping reservations across workers', async () => {
    const calendar = randomUUID(); const p1 = await proposal(worker, calendar); const p2 = await proposal(other, calendar);
    const a = new pg.Client({ connectionString: databaseUrl }); const b = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await attempt(p1, a);
      const blockedInsert = attempt(p2, b).then(() => ({ code: 'unexpected_success' }), error => error as { code: string });
      await a.query('COMMIT');
      expect((await blockedInsert).code).toBe('23P01');
      await b.query('ROLLBACK');
    } finally { await Promise.all([a.end(), b.end()]); }
  });

  it('requires success evidence for event records and makes success terminal', async () => {
    const p = await proposal(); const id = await attempt(p);
    const insertRecord = () => db.query(`INSERT INTO va_records(workspace_id,worker_id,session_id,kind,starts_at,ends_at,time_zone,booking_attempt_id,outcome)
      VALUES($1,$2,$3,'event',$4,$5,'Asia/Dubai',$6,'booked')`, [workspace, worker, p.session, p.start, p.end, id]);
    await expect(insertRecord()).rejects.toThrow('succeeded matching attempt');
    await db.query("UPDATE va_attempts SET status='writing',dispatch_at=now() WHERE id=$1", [id]);
    await db.query("UPDATE va_attempts SET status='succeeded',resolved_at=now() WHERE id=$1", [id]);
    await insertRecord();
    await expect(db.query("UPDATE va_attempts SET status='failed' WHERE id=$1", [id])).rejects.toThrow('invalid booking transition');
    await expect(db.query(`INSERT INTO va_records(workspace_id,worker_id,session_id,kind,outcome,body) VALUES($1,$2,$3,'note','saved','text')`, [workspace, worker, p.session])).rejects.toThrow('cannot save note');
  });

  it('requires a new generation for each recovery owner and fences stale completion', async () => {
    const p = await proposal(); const id = await attempt(p); const firstToken = randomUUID(); const secondToken = randomUUID();
    await db.query("UPDATE va_attempts SET status='writing',dispatch_at=now() WHERE id=$1", [id]);
    await db.query("UPDATE va_attempts SET status='unknown' WHERE id=$1", [id]);
    await expect(db.query("UPDATE va_attempts SET recovery_token=$2,recovery_lease_until=now()+interval '1 minute' WHERE id=$1", [id, firstToken])).rejects.toThrow('new generation');
    await db.query("UPDATE va_attempts SET recovery_token=$2,recovery_generation=1,recovery_lease_until=now()+interval '1 minute' WHERE id=$1", [id, firstToken]);
    await db.query("UPDATE va_attempts SET recovery_token=$2,recovery_generation=2,recovery_lease_until=now()+interval '1 minute' WHERE id=$1", [id, secondToken]);
    const stale = await db.query("UPDATE va_attempts SET status='failed',resolved_at=now() WHERE id=$1 AND recovery_token=$2 AND recovery_generation=1", [id, firstToken]);
    expect(stale.rowCount).toBe(0);
    expect((await db.query('SELECT status FROM va_attempts WHERE id=$1', [id])).rows[0].status).toBe('unknown');
  });

  it('supports speech usage before capture and rejects foreign speech references', async () => {
    const speech = randomUUID();
    await db.query("INSERT INTO va_speech_sessions(id,workspace_id,worker_id,provider) VALUES($1,$2,$3,'simulated')", [speech, workspace, worker]);
    await db.query("INSERT INTO va_usage_events(workspace_id,worker_id,speech_session_id,provider,provider_request_id,operation) VALUES($1,$2,$3,'simulated',$4,'transcribe')", [workspace, worker, speech, randomUUID()]);
    await expect(db.query("INSERT INTO va_usage_events(workspace_id,worker_id,speech_session_id,provider,provider_request_id,operation) VALUES($1,$2,$3,'simulated',$4,'transcribe')", [workspace, other, speech, randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });
});
