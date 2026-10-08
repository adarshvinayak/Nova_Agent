import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor,CalendarProvider,CalendarEvent } from '../../src/lib/domain';
import { capture,editFacts,sessionView } from '../../src/lib/sessions';
import { processSession } from '../../src/lib/conversation';
import { reserveBooking,executeBooking,recoverBooking } from '../../src/lib/booking';
import { getCalendarProvider } from '../../src/lib/providers';
import { ProviderError } from '../../src/lib/errors';
import { pool } from '../../src/lib/db';
import { applyRetention } from '../../scripts/retention-core';
import {resetActionFixtures} from './quota-fixture';
const testUrl=process.env.TEST_DATABASE_URL!;const admin=new Pool({connectionString:testUrl});
const workspace=randomUUID();const a:Actor={id:randomUUID(),workspaceId:workspace,email:'a@test.local',displayName:'A'};
const b:Actor={id:randomUUID(),workspaceId:workspace,email:'b@test.local',displayName:'B'};
let day=1;
beforeAll(async()=>{
 if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw new Error('Isolated test DB required');
 process.env.DATABASE_URL=testUrl;process.env.APP_MODE='demo';
 await admin.query('DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
 await admin.query(await readFile('db/bootstrap-local.sql','utf8'));
 for(const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort()) await admin.query(await readFile('db/migrations/'+file,'utf8'));
 await admin.query("INSERT INTO va_workspaces(id,name) VALUES($1,'Test workspace')",[workspace]);
 for(const w of[a,b])await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)',[w.id,workspace,w.email,w.displayName]);
 await admin.query("INSERT INTO private.va_calendar_connections(workspace_id,calendar_id,calendar_label,provider) VALUES($1,'test-calendar','Test','simulated')",[workspace]);
});
afterAll(async()=>{await admin.end();await pool().end();});
beforeEach(async()=>{await resetActionFixtures(admin,[a,b]);});
async function ready(w=a){
 const c=await capture(w,{text:'Book site inspection',source:'typed',clientCaptureId:randomUUID()});
 await editFacts(w,c.id,{expectedVersion:1,clientActionId:randomUUID(),facts:{intent:'appointment',title:'Site inspection',date:`2030-02-${String(day++).padStart(2,'0')}`,time:'10:00',durationMinutes:30,location:'Warehouse 2',locationNotApplicable:false}});
 await processSession(w,c.id,false);const view=await sessionView(w,c.id);expect(view.state).toBe('ready');expect(view.proposal).not.toBeNull();
 return {id:c.id,p:view.proposal!};
}
function input(p:Awaited<ReturnType<typeof ready>>['p']){return{proposalVersion:p.version,snapshotHash:p.snapshotHash,idempotencyKey:randomUUID()};}
describe('confirmed booking and durable recovery',()=>{
 it('creates nothing before tap; duplicate confirmation and dispatch create one event',async()=>{
  const r=await ready();expect((await admin.query('SELECT count(*) FROM va_attempts')).rows[0].count).toBe('0');
  const key=input(r.p);const [one,two]=await Promise.all([reserveBooking(a,r.p.id,key),reserveBooking(a,r.p.id,key)]);expect(two.id).toBe(one.id);
  const base=await getCalendarProvider(a);const insert=vi.fn(base.insert.bind(base));const provider={queryBusy:base.queryBusy.bind(base),readCreated:base.readCreated.bind(base),insert};
  await Promise.all([executeBooking(a,one.id,provider),executeBooking(a,two.id,provider)]);
  expect(insert).toHaveBeenCalledTimes(1);expect((await sessionView(a,r.id)).state).toBe('booked');
 });
 it('rejects changed replay payload, foreign ownership and stale cards',async()=>{
  const r=await ready();await expect(reserveBooking(b,r.p.id,input(r.p))).rejects.toMatchObject({code:'NOT_FOUND'});
  const view=await sessionView(a,r.id);await editFacts(a,r.id,{expectedVersion:view.version,clientActionId:randomUUID(),facts:{title:'Changed'}});
  await expect(reserveBooking(a,r.p.id,input(r.p))).rejects.toMatchObject({code:'STALE_PROPOSAL'});
  const fresh=await ready();const key=input(fresh.p);await reserveBooking(a,fresh.p.id,key);
  await expect(reserveBooking(a,fresh.p.id,{...key,snapshotHash:'f'.repeat(64)})).rejects.toMatchObject({code:'REPLAY_MISMATCH'});
 });
 it('rechecks external conflicts and never dispatches over a fresh busy interval',async()=>{
  const r=await ready();const reserved=await reserveBooking(a,r.p.id,input(r.p));const insert=vi.fn();
  await executeBooking(a,reserved.id,{queryBusy:async()=>[{start:r.p.snapshot.start,end:r.p.snapshot.end}],insert,readCreated:async()=>null});
  expect(insert).not.toHaveBeenCalled();expect((await sessionView(a,r.id)).attempt?.status).toBe('blocked');
 });
 it('recovers timeout after remote success by readback, without a second insert',async()=>{
  const r=await ready();const reserved=await reserveBooking(a,r.p.id,input(r.p));const base=await getCalendarProvider(a);
  const insert=vi.fn(async(...args:Parameters<CalendarProvider['insert']>)=>{await base.insert(...args);throw new ProviderError('TIMEOUT',true);});
  const provider={queryBusy:base.queryBusy.bind(base),readCreated:base.readCreated.bind(base),insert};
  await executeBooking(a,reserved.id,provider);expect((await sessionView(a,r.id)).attempt?.status).toBe('unknown');
  await recoverBooking(a,reserved.id,provider);expect((await sessionView(a,r.id)).state).toBe('booked');expect(insert).toHaveBeenCalledTimes(1);
 });
 it('keeps reservation on uncertain 404 or readback error; never assumes absence',async()=>{
  const r=await ready();const reserved=await reserveBooking(a,r.p.id,input(r.p));
  const provider:CalendarProvider={queryBusy:async()=>[],insert:async()=>{throw new ProviderError('TIMEOUT',true);},readCreated:async()=>null};
  await executeBooking(a,reserved.id,provider);await recoverBooking(a,reserved.id,provider);
  expect((await sessionView(a,r.id)).attempt?.status).toBe('unknown');
  await recoverBooking(a,reserved.id,{...provider,readCreated:async()=>{throw new ProviderError('REJECTED');}});
  expect((await sessionView(a,r.id)).attempt?.status).toBe('unknown');
 });
 it('fences late original completion after recovery claimed the operation',async()=>{
  const r=await ready();const reserved=await reserveBooking(a,r.p.id,input(r.p));const base=await getCalendarProvider(a);
  let release:(event:CalendarEvent)=>void=()=>{};let signaled:()=>void=()=>{};const writing=new Promise<void>(r=>{signaled=r;});let created!:CalendarEvent;
  const pending=new Promise<CalendarEvent>(r=>{release=r;});
  const provider:CalendarProvider={queryBusy:base.queryBusy.bind(base),readCreated:async()=>null,insert:async(...args)=>{created=await base.insert(...args);signaled();return pending;}};
  const execution=executeBooking(a,reserved.id,provider);await writing;await recoverBooking(a,reserved.id,provider);release(created);await execution;
  expect((await sessionView(a,r.id)).attempt?.status).toBe('unknown');
  await recoverBooking(a,reserved.id,base);expect((await sessionView(a,r.id)).state).toBe('booked');
 });
 it('rejects expired authorizations without creating an attempt',async()=>{
  const r=await ready();const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+360000);
  try{await expect(reserveBooking(a,r.p.id,input(r.p))).rejects.toMatchObject({code:'EXPIRED_PROPOSAL'});}finally{clock.mockRestore();}
 });
});

it('retention redacts settled text but preserves uncertain recovery and replay identities',async()=>{
 const db=await admin.connect();
 try{await db.query('BEGIN');const counts=await applyRetention(db,new Date('2040-01-01T00:00:00Z'));
 expect(counts.redactedSessions).toBeGreaterThan(0);expect(counts.protectedUnresolvedSessions).toBeGreaterThan(0);
 expect((await db.query("SELECT count(*) FROM va_proposals p JOIN va_attempts a ON a.proposal_id=p.id WHERE a.status='unknown' AND p.snapshot='{}'::jsonb")).rows[0].count).toBe('0');
 expect((await db.query('SELECT count(*) FROM va_idempotency')).rows[0].count).not.toBe('0');
 await db.query('ROLLBACK');}finally{db.release();}
});
