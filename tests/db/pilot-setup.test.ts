import {beforeAll,afterAll,it,expect}from 'vitest';
import{readFile,readdir}from 'node:fs/promises';import{Pool}from 'pg';import{randomUUID}from 'node:crypto';
import{initializePilot}from '../../scripts/pilot-setup-core';import{pool}from '../../src/lib/db';
import{capture,editFacts,sessionView}from '../../src/lib/sessions';import{processSession}from '../../src/lib/conversation';import{reserveBooking}from '../../src/lib/booking';import type{Actor}from '../../src/lib/domain';
const url=process.env.TEST_DATABASE_URL!;const admin=new Pool({connectionString:url});
const worker:Actor={id:'20000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000001',email:'user1@pilot.local',displayName:'Alias'};
async function setup(){const db=await admin.connect();try{await db.query('BEGIN');await initializePilot(db);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
beforeAll(async()=>{if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Isolated test database required');process.env.DATABASE_URL=url;process.env.APP_MODE='demo';await admin.query('DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;');await admin.query(await readFile('db/bootstrap-local.sql','utf8'));for(const f of(await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(await readFile('db/migrations/'+f,'utf8'));await setup();});
afterAll(async()=>{await admin.end();await pool().end();});
it('redeploy initialization preserves pending confirmation, revoked permissions, disabled users and configuration version',async()=>{
 const c=await capture(worker,{text:'Book inspection',source:'typed',clientCaptureId:randomUUID()});await editFacts(worker,c.id,{expectedVersion:1,clientActionId:randomUUID(),facts:{intent:'appointment',title:'Inspection',date:'2036-01-01',time:'10:00',durationMinutes:30,location:'Warehouse',locationNotApplicable:false}});await processSession(worker,c.id,false);
 const p=(await sessionView(worker,c.id)).proposal!;expect(p).not.toBeNull();await reserveBooking(worker,p.id,{proposalVersion:p.version,snapshotHash:p.snapshotHash,idempotencyKey:randomUUID()});
 await admin.query("UPDATE va_workers SET active=false,permissions=jsonb_set(permissions,'{tasks}','false') WHERE user_code='user2'");const before=(await admin.query('SELECT config_version FROM va_workspaces WHERE id=$1',[worker.workspaceId])).rows[0].config_version;
 await setup();expect((await admin.query('SELECT config_version FROM va_workspaces WHERE id=$1',[worker.workspaceId])).rows[0].config_version).toBe(before);expect((await admin.query("SELECT active,permissions FROM va_workers WHERE user_code='user2'")).rows[0]).toMatchObject({active:false,permissions:{tasks:false}});expect((await sessionView(worker,c.id)).attempt?.status).toBe('reserved');
});
