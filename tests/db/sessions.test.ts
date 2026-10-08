import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/lib/domain';
import { capture,sessionView,submitTurn,saveNote,dashboard } from '../../src/lib/sessions';
import { pool } from '../../src/lib/db';
import {resetActionFixtures} from './quota-fixture';
const testUrl=process.env.TEST_DATABASE_URL!;
const admin=new Pool({connectionString:testUrl});
const workspace=randomUUID();
const a:Actor={id:randomUUID(),workspaceId:workspace,email:'a@test.local',displayName:'Worker A'};
const b:Actor={id:randomUUID(),workspaceId:workspace,email:'b@test.local',displayName:'Worker B'};
beforeAll(async()=>{
  if(!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('Use an isolated _test database');
  process.env.DATABASE_URL=testUrl;
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS private CASCADE;');
  await admin.query(await readFile('db/bootstrap-local.sql','utf8'));
  for(const path of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort().map(f=>'db/migrations/'+f)) await admin.query(await readFile(path,'utf8'));
  await admin.query("INSERT INTO va_workspaces(id,name) VALUES($1,'Tests')",[workspace]);
  for(const w of [a,b]) await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)',[w.id,workspace,w.email,w.displayName]);
});
afterAll(async()=>{await admin.end();await pool().end();});
beforeEach(async()=>{await resetActionFixtures(admin,[a,b]);});
describe('durable owned capture',()=>{
 it('replays exactly without a second user turn and rejects changed content',async()=>{
   const input={text:'Inspect warehouse tomorrow',source:'typed',clientCaptureId:randomUUID()};
   const first=await capture(a,input);const second=await capture(a,input);
   expect(second).toEqual({id:first.id,process:false});expect((await sessionView(a,first.id)).turns).toHaveLength(1);
   await expect(capture(a,{...input,text:'Changed'})).rejects.toMatchObject({code:'REPLAY_MISMATCH'});
 });
 it('rejects another worker reading or mutating the conversation',async()=>{
   const saved=await capture(a,{text:'Private request',source:'typed',clientCaptureId:randomUUID()});
   await expect(sessionView(b,saved.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(submitTurn(b,saved.id,{text:'Hijack',expectedVersion:1,clientTurnId:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('preserves accepted input and rejects stale competing edits',async()=>{
   const saved=await capture(a,{text:'Meeting',source:'typed',clientCaptureId:randomUUID()});
   const turn={text:'Tomorrow at 14:00',expectedVersion:1,clientTurnId:randomUUID()};
   await submitTurn(a,saved.id,turn);await submitTurn(a,saved.id,turn);
   const view=await sessionView(a,saved.id);expect(view.version).toBe(2);expect(view.turns).toHaveLength(2);
   await expect(submitTurn(a,saved.id,{...turn,clientTurnId:randomUUID()})).rejects.toMatchObject({code:'STALE_VERSION'});
 });
 it('saves a note once without booking and isolates the dashboard',async()=>{
   const saved=await capture(a,{text:'Remember spare cables',source:'typed',clientCaptureId:randomUUID()});
   const input={expectedVersion:1,clientActionId:randomUUID()};await saveNote(a,saved.id,input);await saveNote(a,saved.id,input);
   expect((await sessionView(a,saved.id)).state).toBe('note_saved');
   expect((await admin.query('SELECT count(*) FROM va_attempts')).rows[0].count).toBe('0');
   expect((await dashboard(a,'note')).items).toHaveLength(1);expect((await dashboard(b,'all')).items).toHaveLength(0);
 });
});

it('orders due tasks and shared appointments by what is next and paginates without repeats',async()=>{
 const insertedTasks:string[]=[],insertedEvents:string[]=[];
 try{
  for(let i=23;i>=0;i--){
   const due=new Date(Date.UTC(2038,0,1,10,i)).toISOString();
   const result=await admin.query('INSERT INTO va_tasks(workspace_id,worker_id,assignee_worker_id,title,due_at) VALUES($1,$2,$3,$4,$5) RETURNING id',[workspace,i%2?a.id:b.id,a.id,`Upcoming ${String(i).padStart(2,'0')}`,due]);insertedTasks.push(result.rows[0].id);
  }
  const extras=await admin.query("INSERT INTO va_tasks(workspace_id,worker_id,assignee_worker_id,title,due_at,status) VALUES($1,$2,$2,'No deadline',NULL,'todo'),($1,$2,$2,'Completed', '2037-01-01T00:00:00Z','done'),($1,$3,$3,'Other private task','2036-01-01T00:00:00Z','todo') RETURNING id",[workspace,a.id,b.id]);insertedTasks.push(...extras.rows.map(r=>r.id));
  const event=await admin.query("INSERT INTO private.va_internal_events(workspace_id,worker_id,calendar_id,event_id,title,starts_at,ends_at) VALUES($1,$2,'test','shared-upcoming','Shared appointment','2038-01-01T10:05:30Z','2038-01-01T10:06:00Z') RETURNING id",[workspace,b.id]);insertedEvents.push(event.rows[0].id);
  const pages:Awaited<ReturnType<typeof dashboard>>['items']=[];let cursor:string|undefined;
  do{const page=await dashboard(a,'all',cursor);pages.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
  const upcoming=pages.filter(x=>x.title.startsWith('Upcoming')||x.title==='Shared appointment');
  expect(upcoming.map(x=>x.title)).toEqual([...Array.from({length:6},(_,i)=>`Upcoming ${String(i).padStart(2,'0')}`),'Shared appointment',...Array.from({length:18},(_,i)=>`Upcoming ${String(i+6).padStart(2,'0')}`)]);
  expect(new Set(pages.map(x=>x.id)).size).toBe(pages.length);
  expect(pages.findIndex(x=>x.title==='No deadline')).toBeGreaterThan(pages.findIndex(x=>x.title==='Upcoming 23'));
  expect(pages.findIndex(x=>x.title==='Completed')).toBeGreaterThan(pages.findIndex(x=>x.title==='No deadline'));
  expect(pages.map(x=>x.title)).not.toContain('Other private task');
 }finally{await admin.query('DELETE FROM va_tasks WHERE id=ANY($1::uuid[])',[insertedTasks]);await admin.query('DELETE FROM private.va_internal_events WHERE id=ANY($1::uuid[])',[insertedEvents]);}
});
