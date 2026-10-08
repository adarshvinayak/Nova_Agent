import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/lib/domain';
import { capture,sessionView,submitTurn,saveNote,dashboard } from '../../src/lib/sessions';
import { pool } from '../../src/lib/db';
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
  for(const path of ['db/migrations/001_foundation.sql','db/migrations/002_runtime.sql']) await admin.query(await readFile(path,'utf8'));
  await admin.query("INSERT INTO va_workspaces(id,name) VALUES($1,'Tests')",[workspace]);
  for(const w of [a,b]) await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)',[w.id,workspace,w.email,w.displayName]);
});
afterAll(async()=>{await admin.end();await pool().end();});
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
