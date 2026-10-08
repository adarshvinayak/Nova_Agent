import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/lib/domain';
import { tasks,saveTask,createTaskInTransaction,resolveTaskDraftInTransaction,events,saveEvent,audit,savePermissions } from '../../src/lib/workspace-modules';
import { applyRetention } from '../../scripts/retention-core';
import { capture,editFacts,appendTurn } from '../../src/lib/sessions';
import { actorTransaction,pool } from '../../src/lib/db';
import { InternalCalendarProvider } from '../../src/lib/providers/internal-calendar';
const testUrl=process.env.TEST_DATABASE_URL!;
const admin=new Pool({connectionString:testUrl});const workspace=randomUUID();
const a:Actor={id:randomUUID(),workspaceId:workspace,email:'a@test.local',displayName:'Temporary A'};
const b:Actor={id:randomUUID(),workspaceId:workspace,email:'b@test.local',displayName:'Temporary B'};
const owner:Actor={id:randomUUID(),workspaceId:workspace,email:'owner@test.local',displayName:'Temporary Admin'};
beforeAll(async()=>{
 if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw new Error('Use an isolated _test database');process.env.DATABASE_URL=testUrl;
 await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS private CASCADE;');await admin.query(await readFile('db/bootstrap-local.sql','utf8'));
 for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(await readFile(`db/migrations/${name}`,'utf8'));
 await admin.query("INSERT INTO va_workspaces(id,name) VALUES($1,'Tests')",[workspace]);
 for(const [who,code,role] of [[a,'user1','user'],[b,'user2','user'],[owner,'admin','admin']] as const)await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name,user_code,role) VALUES($1,$2,$3,$4,$5,$6)',[who.id,workspace,who.email,who.displayName,code,role]);
});
afterAll(async()=>{await admin.end();await pool().end();});
describe('shared workspace modules and permissions',()=>{
 it('shares tasks while keeping audit logs own and admin comprehensive',async()=>{
  const task=await saveTask(a,{title:'Install sensor'});await saveTask(b,{id:task.id,title:'Install sensor',status:'done'});
  expect((await tasks(a)).tasks).toHaveLength(1);expect((await tasks(b)).tasks[0].status).toBe('done');
  const own=(await audit(a)).logs;expect(own).toHaveLength(1);expect(own[0]).toMatchObject({userCode:'user1',alias:'Temporary A'});
  expect((await audit(b)).logs).toHaveLength(1);expect((await audit(owner)).logs).toHaveLength(2);
 });
 it('only admin changes permissions; revocation enforced on next request',async()=>{
  const input={action:'permissions',userCode:'user2',permissions:{capture:true,tasks:false,calendar:true,audit:true,settings:true}};
  await expect(savePermissions(a,input)).rejects.toMatchObject({code:'FORBIDDEN'});await savePermissions(owner,input);
  await expect(tasks(b)).rejects.toMatchObject({code:'FORBIDDEN'});expect((await tasks(a)).tasks).toHaveLength(1);
 });
 it('creates shared internal events and atomically rejects simultaneous overlaps',async()=>{
  const input={title:'Inspection',start:'2027-01-03T10:00:00+04:00',end:'2027-01-03T10:30:00+04:00'};
  const results=await Promise.allSettled([saveEvent(a,input),saveEvent(b,input)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((await events(b)).events).toHaveLength(1);const provider=new InternalCalendarProvider(`internal:${workspace}`,workspace);
  expect(await provider.queryBusy(`internal:${workspace}`,input.start,input.end)).toHaveLength(1);
  await expect(provider.readCreated(`internal:${workspace}`,'vc'+randomUUID().replaceAll('-',''))).rejects.toMatchObject({code:'CALENDAR_UNOWNED_EVENT'});
 });
 it('records submitted words, replies, source and field changes atomically without internal tokens',async()=>{
  const {id}=await capture(a,{text:'Book a site inspection',source:'browser_voice',clientCaptureId:randomUUID()});
  await actorTransaction(a,db=>appendTurn(db,a,id,'assistant','Which day works for you?'));
  await editFacts(a,id,{facts:{title:'Site inspection',location:'Dubai office'},expectedVersion:1,clientActionId:randomUUID()});
  const logs=(await audit(a)).logs.filter(row=>row.sessionId===id);
  expect(logs.find(row=>row.eventType==='conversation.user_message'&&row.content.text==='Book a site inspection')).toMatchObject({userCode:'user1',alias:'Temporary A',detail:{source:'browser_voice'}});
  expect(logs.find(row=>row.eventType==='conversation.agent_reply')?.content.text).toBe('Which day works for you?');
  expect(logs.find(row=>row.content.after?.facts?.title==='Site inspection')?.content.before.facts.title).toBeNull();
  expect(JSON.stringify(logs)).not.toContain('processing_token');
  await actorTransaction(a,async tx=>{await tx.query("UPDATE va_sessions SET processing_token=gen_random_uuid(),processing_until=now()+interval '1 minute' WHERE id=$1",[id]);});
  expect((await audit(a)).logs.filter(row=>row.sessionId===id)).toHaveLength(logs.length);
 });
 it('captures the exact confirmed snapshot and decision while excluding idempotency keys',async()=>{
  const {id}=await capture(a,{text:'Confirm inspection',source:'typed',clientCaptureId:randomUUID()});const proposal=randomUUID(),attemptId=randomUUID(),key=randomUUID();
  const snapshot={title:'Inspection',location:'Dubai',start:'2027-02-01T10:00:00+04:00',end:'2027-02-01T10:30:00+04:00',timeZone:'Asia/Dubai'};
  await actorTransaction(a,async db=>{
   await db.query(`INSERT INTO va_proposals(id,workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,expires_at) VALUES($1,$2,$3,$4,1,1,1,'audit-test',$5,$6,$7,$8,now()+interval '5 minutes')`,[proposal,workspace,a.id,id,snapshot,'a'.repeat(64),snapshot.start,snapshot.end]);
   await db.query(`INSERT INTO va_attempts(id,workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,'audit-test',$8,$9,$10)`,[attemptId,workspace,a.id,id,proposal,key,'a'.repeat(64),'vc'+attemptId.replaceAll('-',''),snapshot.start,snapshot.end]);
  });
  const entry=(await audit(a)).logs.find(row=>row.subjectId===attemptId);
  expect(entry?.detail.decision).toBe('confirmed');expect(entry?.content.confirmationSnapshot).toEqual(snapshot);expect(JSON.stringify(entry)).not.toContain(key);
 });
 it('paginates without overlap and never exposes another worker audit content',async()=>{
  await actorTransaction(a,async db=>{await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,event_type,detail,content) SELECT $1,$2,'test.action','{}','{"text":"private message"}'::jsonb FROM generate_series(1,60)`,[workspace,a.id]);});
  const first=await audit(a);expect(first.logs).toHaveLength(50);expect(first.nextCursor).toBeTruthy();const second=await audit(a,first.nextCursor!);
  expect(second.logs.every(row=>!first.logs.some(prev=>prev.id===row.id))).toBe(true);
  expect((await audit(b)).logs.every(row=>row.userCode==='user2')).toBe(true);
  await expect(audit(a,'not-a-cursor')).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
 it('redacts audit text after 30 days while keeping metadata and never recreating expired text',async()=>{
  const oldId=randomUUID();await admin.query(`INSERT INTO private.va_operation_events(id,workspace_id,actor_worker_id,event_type,detail,content,created_at) VALUES($1,$2,$3,'conversation.user_message','{"source":"typed"}','{"text":"sensitive old words"}',now()-interval '31 days')`,[oldId,workspace,a.id]);
  const db=await admin.connect();try{await db.query('BEGIN');const counts=await applyRetention(db);expect(counts.redactedAuditContent).toBeGreaterThan(0);
   const row=(await db.query('SELECT content,detail,content_redacted_at FROM private.va_operation_events WHERE id=$1',[oldId])).rows[0];expect(row.content).toEqual({});expect(row.detail.source).toBe('typed');expect(row.content_redacted_at).toBeTruthy();await db.query('ROLLBACK');
  }finally{db.release();}
 });
 it('retention cannot recreate expired proposal text in a new audit record',async()=>{
  const {id}=await capture(a,{text:'Old proposal for retention',source:'typed',clientCaptureId:randomUUID()});
  const oldText='Expired confidential appointment';const proposal=randomUUID();
  await admin.query("UPDATE va_sessions SET updated_at=now()-interval '31 days' WHERE id=$1",[id]);
  await admin.query(`INSERT INTO va_proposals(id,workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,created_at,expires_at)
    VALUES($1,$2,$3,$4,1,1,1,'retention-test',$5,$6,'2027-07-01T10:00:00+04:00','2027-07-01T10:30:00+04:00',now()-interval '31 days',now()-interval '30 days')`,[proposal,workspace,a.id,id,{title:oldText},'a'.repeat(64)]);
  await admin.query("UPDATE private.va_operation_events SET created_at=now()-interval '31 days' WHERE session_id=$1",[id]);
  const db=await admin.connect();try{await db.query('BEGIN');await applyRetention(db);
   expect((await db.query('SELECT snapshot,status FROM va_proposals WHERE id=$1',[proposal])).rows[0]).toEqual({snapshot:{},status:'expired'});
   const logs=(await db.query('SELECT content FROM private.va_operation_events WHERE session_id=$1',[id])).rows;
   expect(JSON.stringify(logs)).not.toContain(oldText);await db.query('ROLLBACK');
  }finally{db.release();}
 });
 it('assigns by stable user code, keeps creator and assignee visibility, and records exact assignment changes',async()=>{
  await savePermissions(owner,{action:'permissions',userCode:'user2',permissions:{capture:true,tasks:true,calendar:true,audit:true,settings:true}});
  const task=await saveTask(a,{title:'Check the drawings',assigneeUserCode:'user2',dueAt:'2027-03-01T09:00:00+04:00'});
  expect((await tasks(b,true)).tasks.find(row=>row.id===task.id)).toMatchObject({creatorUserCode:'user1',assigneeUserCode:'user2'});
  expect((await tasks(a,true)).tasks.some(row=>row.id===task.id)).toBe(true);
  await saveTask(b,{id:task.id,title:'Check the drawings',assigneeUserCode:'user1'});
  const entry=(await audit(b)).logs.find(row=>row.subjectId===task.id);
  expect(entry?.content.before.assigneeUserCode).toBe('user2');expect(entry?.content.after.assigneeUserCode).toBe('user1');
  expect((await tasks(b,true)).tasks.some(row=>row.id===task.id)).toBe(false);
  await expect(saveTask(a,{title:'Invalid',assigneeUserCode:'nobody'})).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});
  await admin.query("UPDATE va_workers SET active=false WHERE id=$1",[b.id]);
  await expect(saveTask(a,{title:'Inactive',assigneeUserCode:'user2'})).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});
  await admin.query("UPDATE va_workers SET active=true WHERE id=$1",[b.id]);
 });
 it('sorts incomplete task due dates before undated and completed tasks',async()=>{
  const late=await saveTask(a,{title:'Later work',dueAt:'2027-06-02T12:00:00+04:00'});
  const early=await saveTask(a,{title:'Earlier work',dueAt:'2027-06-01T12:00:00+04:00'});
  const done=await saveTask(a,{title:'Completed work',status:'done',dueAt:'2027-05-01T12:00:00+04:00'});
  const ids=(await tasks(a)).tasks.map(row=>row.id);expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(late.id));expect(ids.indexOf(late.id)).toBeLessThan(ids.indexOf(done.id));
 });
 it('resolves task drafts and creates a single task for a retried conversation confirmation',async()=>{
  const {id}=await capture(a,{text:'Assign user2 to inspect the sensor',source:'typed',clientCaptureId:randomUUID()});
  const draft=await actorTransaction(a,db=>resolveTaskDraftInTransaction(db,a,{title:'Inspect sensor',assigneeUserCode:'user2'}));expect(draft.assigneeUserCode).toBe('user2');
  const create=()=>actorTransaction(a,db=>createTaskInTransaction(db,a,{...draft,sourceSessionId:id}));
  const [first,second]=await Promise.all([create(),create()]);expect(first.id).toBe(second.id);
  expect((await admin.query('SELECT count(*)::int AS count FROM va_tasks WHERE source_session_id=$1',[id])).rows[0].count).toBe(1);
  const foreignSession=await capture(b,{text:'Private task',source:'typed',clientCaptureId:randomUUID()});
  await expect(actorTransaction(a,db=>createTaskInTransaction(db,a,{title:'Cannot use another conversation',sourceSessionId:foreignSession.id}))).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('deactivated workers lose all module access',async()=>{
  await savePermissions(owner,{action:'permissions',userCode:'user2',active:false,permissions:{capture:true,tasks:true,calendar:true,audit:true,settings:true}});
  await expect(events(b)).rejects.toMatchObject({code:'UNAUTHORIZED'});
 });
});
