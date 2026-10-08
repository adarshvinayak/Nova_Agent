import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/lib/domain';
import { tasks,saveTask,events,saveEvent,audit,savePermissions } from '../../src/lib/workspace-modules';
import { pool } from '../../src/lib/db';
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
 it('deactivated workers lose all module access',async()=>{
  await savePermissions(owner,{action:'permissions',userCode:'user2',active:false,permissions:{capture:true,tasks:true,calendar:true,audit:true,settings:true}});
  await expect(events(b)).rejects.toMatchObject({code:'UNAUTHORIZED'});
 });
});
