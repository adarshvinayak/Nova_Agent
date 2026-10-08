import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {actorTransaction,pool} from '../../src/lib/db';
import {actionQuota,refreshActionQuota,startAction,touchAction,assertActionActive,finishAction,hqUsers,resetUserActions} from '../../src/lib/action-quota';
import type {Actor,CalendarEvent,CalendarProvider} from '../../src/lib/domain';
import {emptyFacts} from '../../src/lib/domain';
import {capture,submitTurn,editFacts,completeSession,sessionView} from '../../src/lib/sessions';
import {processSession} from '../../src/lib/conversation';
import {reserveBooking,executeBooking,recoverBooking} from '../../src/lib/booking';
import {ProviderError} from '../../src/lib/errors';
const providers=vi.hoisted(()=>({extract:vi.fn(),queryBusy:vi.fn()}));
vi.mock('../../src/lib/providers',()=>({getLanguageProvider:()=>({extract:providers.extract}),getCalendarProvider:async()=>({queryBusy:providers.queryBusy})}));
const url=process.env.TEST_DATABASE_URL!;
const db=new Pool({connectionString:url});
const workspaceId=randomUUID();
const admin:Actor={id:randomUUID(),workspaceId,email:'admin@local.test',displayName:'Admin',role:'admin'};
async function worker(role:'user'|'admin'='user'):Promise<Actor>{
 const actor:Actor={id:randomUUID(),workspaceId,email:randomUUID()+'@local.test',displayName:'Quota test',role};
 await db.query('INSERT INTO va_workers(id,workspace_id,email,display_name,role,user_code) VALUES($1,$2,$3,$4,$5,$6)',[actor.id,workspaceId,actor.email,actor.displayName,role,actor.id]);return actor;
}
async function draft(actor:Actor){
 const id=randomUUID();await db.query('INSERT INTO va_sessions(id,workspace_id,worker_id,state) VALUES($1,$2,$3,$4)',[id,workspaceId,actor.id,'clarifying']);return id;
}
const begin=(actor:Actor,id:string)=>actorTransaction(actor,client=>startAction(client,actor,id));
const finish=(actor:Actor,id:string,reason:'confirmed'|'completed'|'cancelled'='completed')=>actorTransaction(actor,client=>finishAction(client,actor,id,reason));
beforeAll(async()=>{
 if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Use isolated _test database');
 process.env.DATABASE_URL=url;process.env.APP_MODE='demo';
 await db.query('DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public');
 await db.query(await readFile('db/bootstrap-local.sql','utf8'));
 for(const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile('db/migrations/'+file,'utf8'));
 await db.query('INSERT INTO va_workspaces(id,name) VALUES($1,$2)',[workspaceId,'Quota tests']);
 await db.query("INSERT INTO private.va_calendar_connections(workspace_id,calendar_id,calendar_label,provider) VALUES($1,'quota-calendar','Quota test','simulated')",[workspaceId]);
 await db.query('INSERT INTO va_workers(id,workspace_id,email,display_name,role) VALUES($1,$2,$3,$4,$5)',[admin.id,workspaceId,admin.email,admin.displayName,'admin']);
});
afterAll(async()=>{await db.end();await pool().end();});

it('serializes competing new requests to exactly three reservations per user',async()=>{
 const actor=await worker();const ids=await Promise.all(Array.from({length:8},()=>draft(actor)));
 const results=await Promise.allSettled(ids.map(id=>begin(actor,id)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
 expect(results.filter(r=>r.status==='rejected').every(r=>r.status==='rejected'&&r.reason.code==='ACTION_LIMIT_REACHED')).toBe(true);
 expect(await refreshActionQuota(actor)).toMatchObject({used:0,active:3,remaining:0,exhausted:false});
 const another=await worker();await begin(another,await draft(another));expect(await refreshActionQuota(another)).toMatchObject({active:1,remaining:2});
});
it('followups use the same slot, and confirmation counts once even with concurrent retries',async()=>{
 const actor=await worker();const first=await draft(actor);await begin(actor,first);
 await actorTransaction(actor,async client=>{await touchAction(client,actor,first);await touchAction(client,actor,first);});
 await Promise.all([finish(actor,first),finish(actor,first)]);
 expect(await refreshActionQuota(actor)).toMatchObject({used:1,active:0,remaining:2});
 const second=await draft(actor);await begin(actor,second);await finish(actor,second);
 const third=await draft(actor);await begin(actor,third);
 await actorTransaction(actor,client=>touchAction(client,actor,third));
 expect(await refreshActionQuota(actor)).toMatchObject({used:2,active:1,remaining:0,exhausted:false});
 await finish(actor,third);expect(await refreshActionQuota(actor)).toMatchObject({used:3,active:0,remaining:0,exhausted:true});
 await expect(begin(actor,await draft(actor))).rejects.toMatchObject({code:'ACTION_LIMIT_REACHED'});
});
it('counts inactivity from USER activity, ignores polling/provider checks and commits expiry before rejection',async()=>{
 const actor=await worker();const id=await draft(actor);await begin(actor,id);
 await db.query("UPDATE private.va_actions SET last_user_activity_at=now()-interval '2 minutes 59 seconds' WHERE session_id=$1",[id]);
 const before=(await db.query('SELECT last_user_activity_at FROM private.va_actions WHERE session_id=$1',[id])).rows[0].last_user_activity_at;
 await refreshActionQuota(actor);await actorTransaction(actor,client=>assertActionActive(client,actor,id));
 const after=(await db.query('SELECT last_user_activity_at FROM private.va_actions WHERE session_id=$1',[id])).rows[0].last_user_activity_at;
 expect(after.toISOString()).toBe(before.toISOString());
 await db.query("UPDATE private.va_actions SET last_user_activity_at=now()-interval '3 minutes' WHERE session_id=$1",[id]);
 expect(await refreshActionQuota(actor)).toMatchObject({used:1,active:0,remaining:2});
 await expect(actorTransaction(actor,client=>touchAction(client,actor,id))).rejects.toMatchObject({code:'ACTION_EXPIRED'});
 expect((await db.query('SELECT state FROM va_sessions WHERE id=$1',[id])).rows[0].state).toBe('action_expired');
 expect(await refreshActionQuota(actor)).toMatchObject({used:1});
});
it('successful user activity restarts the idle timer while stale activity cannot revive a request',async()=>{
 const actor=await worker();const id=await draft(actor);await begin(actor,id);
 await db.query("UPDATE private.va_actions SET last_user_activity_at=now()-interval '2 minutes' WHERE session_id=$1",[id]);
 await actorTransaction(actor,client=>touchAction(client,actor,id));
 expect(Number((await db.query('SELECT extract(epoch FROM now()-last_user_activity_at) AS age FROM private.va_actions WHERE session_id=$1',[id])).rows[0].age)).toBeLessThan(2);
 await db.query("UPDATE private.va_actions SET last_user_activity_at=now()-interval '3 minutes 1 second' WHERE session_id=$1",[id]);
 await expect(actorTransaction(actor,client=>touchAction(client,actor,id))).rejects.toMatchObject({code:'ACTION_EXPIRED'});
});
it('cancellation closes the draft and consumes one action',async()=>{
 const actor=await worker();const id=await draft(actor);await begin(actor,id);await finish(actor,id,'cancelled');
 expect(await refreshActionQuota(actor)).toMatchObject({used:1,active:0});
 expect((await db.query('SELECT state FROM va_sessions WHERE id=$1',[id])).rows[0].state).toBe('cancelled');
});
it('uses the fresh membership role, exempts admins and blocks forged admin and cross-workspace reset access',async()=>{
 for(let n=0;n<5;n++)await begin({...admin,role:'user'},await draft(admin));
 expect(await refreshActionQuota(admin)).toMatchObject({admin:true,exhausted:false,remaining:3});
 const actor=await worker();const spoof={...actor,role:'admin' as const};
 await expect(hqUsers(spoof)).rejects.toMatchObject({code:'FORBIDDEN'});
 await expect(resetUserActions(spoof,actor.id)).rejects.toMatchObject({code:'FORBIDDEN'});
 const otherWorkspace=randomUUID();await db.query('INSERT INTO va_workspaces(id,name) VALUES($1,$2)',[otherWorkspace,'Other']);
 const otherId=randomUUID();await db.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)',[otherId,otherWorkspace,'other@local.test','Other']);
 await expect(resetUserActions(admin,otherId)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('admin reset restores three requests and invalidates old unconfirmed flows with an audited generation',async()=>{
 const actor=await worker();const completed=await draft(actor),active=await draft(actor);await begin(actor,completed);await finish(actor,completed);await begin(actor,active);
 expect((await hqUsers(admin)).find(u=>u.id===actor.id)).toMatchObject({used:1,active:1,remaining:1});
 expect(await resetUserActions(admin,actor.id)).toMatchObject({used:0,active:0,remaining:3,generation:2});
 await expect(actorTransaction(actor,client=>touchAction(client,actor,active))).rejects.toMatchObject({code:'ACTION_CLOSED'});
 expect((await db.query('SELECT state FROM va_sessions WHERE id=$1',[active])).rows[0].state).toBe('cancelled');
 await finish(actor,completed);expect(await refreshActionQuota(actor)).toMatchObject({used:0});
 const events=(await db.query("SELECT actor_worker_id,detail FROM private.va_operation_events WHERE event_type='action.quota_reset' AND detail->>'targetWorkerId'=$1",[actor.id])).rows;
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actor_worker_id:admin.id,detail:{targetWorkerId:actor.id,previousUsed:1,closedDrafts:1,generation:2}});
});
it('reset never invalidates an already-confirmed booking, even when its action accounting was incomplete',async()=>{
 const actor=await worker(),id=await draft(actor);await begin(actor,id);
 const proposal=randomUUID(),attempt=randomUUID();const starts='2035-01-01T10:00:00Z',ends='2035-01-01T10:30:00Z';
 await db.query(`INSERT INTO va_proposals(id,workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,expires_at)
 VALUES($1,$2,$3,$4,1,1,1,$4::uuid::text,'{}',$5,$6,$7,now()+interval '10 minutes')`,[proposal,workspaceId,actor.id,id,'a'.repeat(64),starts,ends]);
 await db.query(`INSERT INTO va_attempts(workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at,id)
 VALUES($1,$2,$3,$4,$5,$6,$3::uuid::text,$7,$8,$9,$10)`,[workspaceId,actor.id,id,proposal,randomUUID(),'a'.repeat(64),'vc'+attempt.replaceAll('-',''),starts,ends,attempt]);
 await db.query("UPDATE va_sessions SET state='confirming' WHERE id=$1",[id]);
 await resetUserActions(admin,actor.id);
 expect((await db.query('SELECT state FROM va_sessions WHERE id=$1',[id])).rows[0].state).toBe('confirming');
 expect((await db.query('SELECT status FROM va_attempts WHERE session_id=$1',[id])).rows[0].status).toBe('reserved');
 expect(await refreshActionQuota(actor)).toMatchObject({used:0,remaining:3});
});
it('lazily adopts old unconfirmed sessions without charging historical completed records',async()=>{
 const actor=await worker();const id=await draft(actor);
 await actorTransaction(actor,client=>touchAction(client,actor,id));expect(await refreshActionQuota(actor)).toMatchObject({active:1,used:0});
 const old=await draft(actor);await db.query("UPDATE va_sessions SET state='note_saved' WHERE id=$1",[old]);
 await finish(actor,old);expect(await refreshActionQuota(actor)).toMatchObject({active:1,used:0});
 await expect(actorTransaction(actor,client=>touchAction(client,actor,old))).rejects.toMatchObject({code:'ACTION_CLOSED'});
});
it('explicit complete is idempotent after followups and ends one full request without creating a task',async()=>{
 const actor=await worker();const saved=await capture(actor,{text:'Help me with a request',source:'typed',clientCaptureId:randomUUID()});
 await submitTurn(actor,saved.id,{text:'Actually I have finished',expectedVersion:1,clientTurnId:randomUUID()});
 expect(await refreshActionQuota(actor)).toMatchObject({used:0,active:1});
 const input={expectedVersion:2,clientActionId:randomUUID()};
 await Promise.all([completeSession(actor,saved.id,input),completeSession(actor,saved.id,input)]);
 expect((await sessionView(actor,saved.id)).state).toBe('completed');
 expect(await refreshActionQuota(actor)).toMatchObject({used:1,active:0,remaining:2});
 expect((await db.query('SELECT count(*) FROM va_tasks WHERE source_session_id=$1',[saved.id])).rows[0].count).toBe('0');
});
it('cancels a draft mid-followup without invoking the paid language provider',async()=>{
 providers.extract.mockClear();const actor=await worker();
 const saved=await capture(actor,{text:'Book an appointment',source:'typed',clientCaptureId:randomUUID()});
 await db.query("UPDATE va_sessions SET state='clarifying',facts=$2 WHERE id=$1",[saved.id,{...emptyFacts(),intent:'appointment'}]);
 await submitTurn(actor,saved.id,{text:'Cancel it',expectedVersion:1,clientTurnId:randomUUID()});
 await processSession(actor,saved.id);
 const view=await sessionView(actor,saved.id);expect(view.state).toBe('cancelled');expect(view.turns.at(-1)?.body).toBe('Request cancelled.');
 expect(providers.extract).not.toHaveBeenCalled();expect(await refreshActionQuota(actor)).toMatchObject({used:1,active:0,remaining:2});
});
it('asks about an ambiguous model cancellation without discarding the existing draft or consuming its action',async()=>{
 const actor=await worker(),original={...emptyFacts(),intent:'appointment' as const,title:'Site inspection'};
 const saved=await capture(actor,{text:'Book site inspection',source:'typed',clientCaptureId:randomUUID()});
 await db.query("UPDATE va_sessions SET state='clarifying',facts=$2 WHERE id=$1",[saved.id,original]);
 await submitTurn(actor,saved.id,{text:'I am not sure whether we should proceed with this',expectedVersion:1,clientTurnId:randomUUID()});
 const question='Would you like to discard this draft or keep working on it?';
 providers.extract.mockResolvedValue({facts:{...original,intent:'cancel',ambiguities:[question]},usage:{requestId:randomUUID(),inputTokens:30,outputTokens:20}});
 await processSession(actor,saved.id);
 const view=await sessionView(actor,saved.id);expect(view.state).toBe('clarifying');expect(view.facts).toEqual(original);expect(view.turns.at(-1)?.body).toBe(question);
 expect(await refreshActionQuota(actor)).toMatchObject({used:0,active:1,remaining:2});
});
it('third-action confirmation consumes its last allowance while dispatch, exact replay and uncertain recovery remain available',async()=>{
 const actor=await worker();
 for(let n=0;n<2;n++){
  const saved=await capture(actor,{text:'Finished request '+n,source:'typed',clientCaptureId:randomUUID()});
  await completeSession(actor,saved.id,{expectedVersion:1,clientActionId:randomUUID()});
 }
 const saved=await capture(actor,{text:'Book maintenance',source:'typed',clientCaptureId:randomUUID()});
 await editFacts(actor,saved.id,{expectedVersion:1,clientActionId:randomUUID(),facts:{intent:'appointment',title:'Maintenance',date:'2039-01-01',time:'10:00',durationMinutes:30,location:'Dubai',locationNotApplicable:false}});
 providers.queryBusy.mockResolvedValue([]);await processSession(actor,saved.id,false);
 const proposal=(await sessionView(actor,saved.id)).proposal!;expect(proposal).not.toBeNull();
 expect(await refreshActionQuota(actor)).toMatchObject({used:2,active:1,remaining:0,exhausted:false});
 const input={proposalVersion:proposal.version,snapshotHash:proposal.snapshotHash,idempotencyKey:randomUUID()};
 const attempt=await reserveBooking(actor,proposal.id,input);
 expect(await refreshActionQuota(actor)).toMatchObject({used:3,active:0,remaining:0,exhausted:true});
 await expect(capture(actor,{text:'Fourth request',source:'typed',clientCaptureId:randomUUID()})).rejects.toMatchObject({code:'ACTION_LIMIT_REACHED'});
 let created:CalendarEvent|null=null;
 const provider:CalendarProvider={queryBusy:vi.fn(async()=>[]),insert:vi.fn(async(_calendar,id,snapshot,intentHash)=>{
  created={...snapshot,id,intentHash,status:'confirmed'};throw new ProviderError('CALENDAR_TIMEOUT',true);
 }),readCreated:vi.fn(async()=>created)};
 await executeBooking(actor,attempt.id,provider);expect((await sessionView(actor,saved.id)).state).toBe('booking_unknown');
 expect(await reserveBooking(actor,proposal.id,input)).toEqual({id:attempt.id,created:false});
 await recoverBooking(actor,attempt.id,provider);expect((await sessionView(actor,saved.id)).state).toBe('booked');
 expect(provider.insert).toHaveBeenCalledTimes(1);expect(provider.readCreated).toHaveBeenCalledTimes(1);
 expect(await refreshActionQuota(actor)).toMatchObject({used:3,active:0});
});
