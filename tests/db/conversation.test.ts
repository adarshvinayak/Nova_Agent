import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { capture,sessionView,submitTurn,editFacts,saveNote,confirmTask } from '../../src/lib/sessions';
import { processSession } from '../../src/lib/conversation';
import { pool } from '../../src/lib/db';
import type { Actor,Facts } from '../../src/lib/domain';
import { agenda,taskDraft } from '../../src/lib/agenda';
import { emptyFacts } from '../../src/lib/domain';
import { ProviderError } from '../../src/lib/errors';
import {resetActionFixtures} from './quota-fixture';
const mocks=vi.hoisted(()=>({extract:vi.fn(),queryBusy:vi.fn()}));
vi.mock('../../src/lib/providers',()=>({getLanguageProvider:()=>({extract:mocks.extract}),getCalendarProvider:async()=>({queryBusy:mocks.queryBusy})}));
const url=process.env.TEST_DATABASE_URL!;
const admin=new Pool({connectionString:url});
const actor:Actor={id:randomUUID(),workspaceId:randomUUID(),email:'test@local.test',displayName:'Test'};
const other:Actor={id:randomUUID(),workspaceId:actor.workspaceId,email:'other@local.test',displayName:'Other',userCode:'user2'};
actor.userCode='user1';
const facts:Facts={intent:'appointment',title:'Inspection',date:'2035-01-01',time:'10:00',durationMinutes:30,location:'Warehouse',locationNotApplicable:false,timeZone:'Asia/Dubai',ambiguities:[]};
beforeAll(async()=>{
 if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Isolated test database required');
 process.env.DATABASE_URL=url;process.env.APP_MODE='demo';
 await admin.query('DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
 await admin.query(await readFile('db/bootstrap-local.sql','utf8'));
 for(const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(await readFile('db/migrations/'+file,'utf8'));
 await admin.query("INSERT INTO va_workspaces(id,name) VALUES($1,'Test')",[actor.workspaceId]);
 await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)',[actor.id,actor.workspaceId,actor.email,actor.displayName]);
 await admin.query('UPDATE va_workers SET user_code=$2 WHERE id=$1',[actor.id,'user1']);
 await admin.query('INSERT INTO va_workers(id,workspace_id,email,display_name,user_code) VALUES($1,$2,$3,$4,$5)',[other.id,other.workspaceId,other.email,other.displayName,other.userCode]);
 await admin.query("INSERT INTO private.va_calendar_connections(workspace_id,calendar_id,calendar_label,provider) VALUES($1,'test','Test','simulated')",[actor.workspaceId]);
});
afterAll(async()=>{await admin.end();await pool().end();});
beforeEach(async()=>{await resetActionFixtures(admin,[actor,other]);});
it('anchors extraction to persisted input time and preserves extracted facts when calendar is unavailable',async()=>{
 const saved=await capture(actor,{text:'Book inspection tomorrow',source:'typed',clientCaptureId:randomUUID()});
 const anchor='2026-10-07T19:59:00.000Z';
 await admin.query("UPDATE va_turns SET created_at=$2 WHERE session_id=$1 AND speaker='user'",[saved.id,anchor]);
 mocks.extract.mockResolvedValue({facts,usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 mocks.queryBusy.mockRejectedValue(new ProviderError('CALENDAR_UNAVAILABLE'));
 await processSession(actor,saved.id);
 const failure=(await admin.query("SELECT detail FROM private.va_operation_events WHERE subject_id=$1 AND event_type='conversation.processing_failed'",[saved.id])).rows[0];
 expect(failure.detail.errorCode).toBe('CALENDAR_UNAVAILABLE');expect(failure.detail.processingMsBeforeCommit).toBeGreaterThanOrEqual(0);
 expect(mocks.extract.mock.calls[0][2]).toBe(anchor);
 const failed=await sessionView(actor,saved.id);expect(failed.state).toBe('failed');expect(failed.facts).toEqual(facts);
 mocks.queryBusy.mockResolvedValue([]);
 await processSession(actor,saved.id,false);
 const recovered=await sessionView(actor,saved.id);expect(recovered.state).toBe('ready');expect(recovered.proposal?.snapshot.title).toBe('Inspection');
});

async function extracted(text:string,next:Facts){
 mocks.extract.mockResolvedValue({facts:next,usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 mocks.queryBusy.mockResolvedValue([]);
 const saved=await capture(actor,{text,source:'typed',clientCaptureId:randomUUID()});
 await processSession(actor,saved.id);return sessionView(actor,saved.id);
}
it('drafts a note without writing, saves its corrected text once, then closes the conversation',async()=>{
 const first=await extracted('Note: call supplier',{...emptyFacts(),intent:'note',title:'Call supplier'});
 expect(first.state).toBe('note_ready');
 expect((await admin.query('SELECT count(*) FROM va_records WHERE session_id=$1',[first.id])).rows[0].count).toBe('0');
 await submitTurn(actor,first.id,{text:'Change supplier to customer',expectedVersion:first.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...first.facts,title:'Call customer'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,first.id);
 const updated=await sessionView(actor,first.id);
 expect(mocks.extract.mock.calls.at(-1)?.[1]).toEqual(first.facts);
 expect(mocks.extract.mock.calls.at(-1)?.[3]).toMatchObject({selfUserCode:'user1',users:expect.arrayContaining([{userCode:'user2'}]),turns:expect.arrayContaining([{speaker:'user',body:'Change supplier to customer'}])});
 await expect(saveNote(actor,first.id,{expectedVersion:first.version,clientActionId:randomUUID()})).rejects.toMatchObject({code:'STALE_VERSION'});
 const key={expectedVersion:updated.version,clientActionId:randomUUID()};
 await Promise.all([saveNote(actor,first.id,key),saveNote(actor,first.id,key)]);
 const record=(await admin.query('SELECT title,body FROM va_records WHERE session_id=$1',[first.id])).rows;
 expect(record).toEqual([{title:'Call customer',body:'Call customer'}]);
 const final=await sessionView(actor,first.id);expect(final.state).toBe('note_saved');
 await expect(submitTurn(actor,first.id,{text:'Change again',expectedVersion:final.version,clientTurnId:randomUUID()})).rejects.toMatchObject({code:'ACTION_CLOSED'});
 await expect(editFacts(actor,first.id,{facts:{title:'Changed'},expectedVersion:final.version,clientActionId:randomUUID()})).rejects.toMatchObject({code:'ACTION_CLOSED'});
});
it('saves the corrected full note body separately from its concise title',async()=>{
 const original='Supplier details that should be replaced. '.repeat(12).trim();
 const first=await extracted('Note: '+original,{...emptyFacts(),intent:'note',title:'Supplier follow-up',noteText:original});
 await submitTurn(actor,first.id,{text:'Replace the note text with corrected customer details',expectedVersion:first.version,clientTurnId:randomUUID()});
 const corrected='Corrected customer purchase-order details and line-item references. '.repeat(14).trim();
 mocks.extract.mockResolvedValue({facts:{...first.facts,title:'Customer follow-up',noteText:corrected},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,first.id);const updated=await sessionView(actor,first.id);
 await saveNote(actor,first.id,{expectedVersion:updated.version,clientActionId:randomUUID()});
 const record=(await admin.query('SELECT title,body FROM va_records WHERE session_id=$1',[first.id])).rows[0];
 expect(record).toEqual({title:'Customer follow-up',body:corrected});
 expect(record.body.length).toBeGreaterThan(300);expect(record.body).not.toContain(original);
});
it('drafts an assigned task, revalidates its recipient on confirm, and prevents duplicate or terminal edits',async()=>{
 const view=await extracted('Assign check stock to user2 tomorrow',{...emptyFacts(),intent:'task',title:'Check stock',date:'2035-02-01',assigneeUserCode:'user2'});
 expect(view.state).toBe('task_ready');expect(view.taskDraft).toEqual({title:'Check stock',assigneeUserCode:'user2',dueAt:'2035-02-01T19:59:00.000Z'});
 expect((await admin.query('SELECT count(*) FROM va_tasks WHERE source_session_id=$1',[view.id])).rows[0].count).toBe('0');
 await admin.query('UPDATE va_workers SET active=false WHERE id=$1',[other.id]);
 await expect(confirmTask(actor,view.id,{expectedVersion:view.version,clientActionId:randomUUID()})).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});
 await admin.query('UPDATE va_workers SET active=true WHERE id=$1',[other.id]);
 const key={expectedVersion:view.version,clientActionId:randomUUID()};
 await Promise.all([confirmTask(actor,view.id,key),confirmTask(actor,view.id,key)]);
 const rows=(await admin.query('SELECT title,assignee_worker_id FROM va_tasks WHERE source_session_id=$1',[view.id])).rows;
 expect(rows).toEqual([{title:'Check stock',assignee_worker_id:other.id}]);
 const final=await sessionView(actor,view.id);expect(final.state).toBe('task_saved');
 await expect(submitTurn(actor,view.id,{text:'Change task',expectedVersion:final.version,clientTurnId:randomUUID()})).rejects.toMatchObject({code:'ACTION_CLOSED'});
 await expect(saveNote(actor,view.id,{expectedVersion:final.version,clientActionId:randomUUID()})).rejects.toMatchObject({code:'ACTION_CLOSED'});
});
it('asks about invalid recipients and dates rather than assigning silently; self remains a valid default',async()=>{
 expect((await taskDraft(actor,{...emptyFacts(),intent:'task',title:'Check stock',assigneeUserCode:'someone'})).draft).toBeNull();
 expect((await taskDraft(actor,{...emptyFacts(),intent:'task',title:'Check stock',date:'2035-02-30',assigneeUserCode:null})).draft).toBeNull();
 expect((await taskDraft(actor,{...emptyFacts(),intent:'task',title:'Check stock',assigneeUserCode:null})).draft).toEqual({title:'Check stock',assigneeUserCode:'user1',dueAt:null});
});
it('redirects an unrelated request without losing the unconfirmed draft or creating another proposal',async()=>{
 const initial=await extracted('Book inspection',facts);expect(initial.state).toBe('ready');
 await submitTurn(actor,initial.id,{text:'Tell me about movies',expectedVersion:initial.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...emptyFacts(),intent:'unsupported'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,initial.id);
 const result=await sessionView(actor,initial.id);expect(result.state).toBe('clarifying');expect(result.facts).toEqual(initial.facts);expect(result.proposal).toBeNull();
 expect(result.turns.at(-1)?.body).toContain('appointments');
 expect((await admin.query('SELECT count(*) FROM va_attempts WHERE session_id=$1',[initial.id])).rows[0].count).toBe('0');
});
it('answers an agenda query in the conversation with a structured layout and no write',async()=>{
 const before=(await admin.query('SELECT count(*) FROM va_tasks')).rows[0].count;
 const view=await extracted('What are my tasks?',{...emptyFacts(),intent:'agenda',agendaScope:'my_tasks'});
 expect(view.state).toBe('clarifying');expect(view.agenda).toMatchObject({scope:'my_tasks',label:'My tasks'});expect(view.taskDraft).toBeNull();expect(view.proposal).toBeNull();
 expect((await admin.query('SELECT count(*) FROM va_tasks')).rows[0].count).toBe(before);
});
it('filters today in UAE time, includes only own assigned tasks and shared appointments, and checks fresh permissions',async()=>{
 const now=new Date('2035-04-01T20:30:00.000Z'); // 00:30 on April 2 in Dubai.
 const taskIds:{id:string;title:string}[]=[];
 for(const [title,creator,assignee,due,status] of [
  ['Own today',other.id,actor.id,'2035-04-01T21:00:00Z','todo'],
  ['Own tomorrow',actor.id,actor.id,'2035-04-02T20:00:00Z','todo'],
  ['Assigned to other',actor.id,other.id,'2035-04-01T22:00:00Z','todo'],
  ['Completed',actor.id,actor.id,'2035-04-01T23:00:00Z','done'],
 ] as const){const r=await admin.query('INSERT INTO va_tasks(workspace_id,worker_id,assignee_worker_id,title,due_at,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[actor.workspaceId,creator,assignee,title,due,status]);taskIds.push({id:r.rows[0].id,title});}
 const events=await admin.query("INSERT INTO private.va_internal_events(workspace_id,worker_id,calendar_id,event_id,title,starts_at,ends_at) VALUES($1,$2,'agenda-test','shared-today','Shared today','2035-04-01T22:00:00Z','2035-04-01T23:00:00Z'),($1,$2,'agenda-test','next-day','Next UAE day','2035-04-02T20:00:00Z','2035-04-02T21:00:00Z') RETURNING id",[actor.workspaceId,other.id]);
 try{
  const today=await agenda(actor,'today',now);
  expect(today.items.map(x=>x.title)).toEqual(['Own today','Shared today']);
  expect(today.items[0].userCode).toBe('user1');expect(today.items[1].userCode).toBe('user2');
  const own=await agenda(actor,'my_tasks',now);
  expect(own.items.map(x=>x.title)).toContain('Own tomorrow');expect(own.items.map(x=>x.title)).not.toContain('Assigned to other');
  await admin.query(`UPDATE va_workers SET permissions=permissions||'{"tasks":false}'::jsonb WHERE id=$1`,[actor.id]);
  await expect(agenda({...actor,permissions:{tasks:true}},'my_tasks',now)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await agenda(actor,'today_appointments',now)).items.map(x=>x.title)).toEqual(['Shared today']);
 }finally{await admin.query(`UPDATE va_workers SET permissions=permissions||'{"tasks":true}'::jsonb WHERE id=$1`,[actor.id]);await admin.query('DELETE FROM va_tasks WHERE id=ANY($1::uuid[])',[taskIds.map(x=>x.id)]);await admin.query('DELETE FROM private.va_internal_events WHERE id=ANY($1::uuid[])',[events.rows.map(x=>x.id)]);}
});

it('derives a note heading and ignores a redundant model title question without losing the body',async()=>{
 const body='Synthetic example: discuss the delivery schedule.\nKeep the order reference with it.';
 const view=await extracted('Add a note: '+body,{...emptyFacts(),intent:'note',title:null,noteText:body,ambiguities:['Please provide a title for the note.']});
 expect(view.state).toBe('note_ready');expect(view.facts.title).toBe('Synthetic example: discuss the delivery schedule.');
 expect(view.turns.at(-1)?.body).toBe('Note ready. Review and confirm.');
 await saveNote(actor,view.id,{expectedVersion:view.version,clientActionId:randomUUID()});
 expect((await admin.query('SELECT title,body FROM va_records WHERE session_id=$1',[view.id])).rows[0]).toEqual({title:view.facts.title,body});
});
it('asks for actual missing note content and refuses to save a heading as the missing body',async()=>{
 const view=await extracted('Create a note',{...emptyFacts(),intent:'note',title:'New note',noteText:null,ambiguities:['Please provide a title for the note.']});
 expect(view.state).toBe('clarifying');expect(view.turns.at(-1)?.body).toBe('What should the note say?');
 await expect(saveNote(actor,view.id,{expectedVersion:view.version,clientActionId:randomUUID()})).rejects.toMatchObject({code:'NOT_READY'});
 await submitTurn(actor,view.id,{text:'Synthetic example: call the supplier.',expectedVersion:view.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...view.facts,noteText:'Synthetic example: call the supplier.',ambiguities:[]},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,view.id);expect((await sessionView(actor,view.id)).state).toBe('note_ready');
});
it('does not repeat a resolved appointment name question or require task duration and location',async()=>{
 const appointment=await extracted('Book inspection', {...facts,ambiguities:['Please provide an event name.']});
 expect(appointment.state).toBe('ready');expect(appointment.proposal?.snapshot.title).toBe('Inspection');
 const task=await extracted('Create task: call supplier',{...emptyFacts(),intent:'task',title:'Call supplier',assigneeUserCode:null,ambiguities:['Please provide a duration.','Where will it take place?']});
 expect(task.state).toBe('task_ready');expect(task.taskDraft?.assigneeUserCode).toBe('user1');
});
it('returns to the existing appointment draft after answering an agenda query',async()=>{
 const initial=await extracted('Book inspection',facts);
 await submitTurn(actor,initial.id,{text:'Show my tasks',expectedVersion:initial.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...initial.facts,intent:'agenda',agendaScope:'my_tasks'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,initial.id);const summary=await sessionView(actor,initial.id);
 expect(summary.agenda?.scope).toBe('my_tasks');expect(summary.facts.intent).toBe('appointment');expect(summary.facts.title).toBe('Inspection');
 await submitTurn(actor,initial.id,{text:'Change the time to 11 am',expectedVersion:summary.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...summary.facts,time:'11:00'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,initial.id);const updated=await sessionView(actor,initial.id);
 expect(updated.state).toBe('ready');expect(updated.facts.time).toBe('11:00');expect(updated.agenda).toBeNull();
});
it('preserves a draft through an agenda range question and its answer',async()=>{
 const initial=await extracted('Book inspection',facts);
 await submitTurn(actor,initial.id,{text:'Show my agenda',expectedVersion:initial.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...initial.facts,intent:'agenda',agendaScope:null},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,initial.id);const pending=await sessionView(actor,initial.id);
 expect(pending.turns.at(-1)?.body).toContain('today');expect(pending.agenda).toBeNull();
 await submitTurn(actor,initial.id,{text:'My tasks',expectedVersion:pending.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...pending.facts,agendaScope:'my_tasks'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await processSession(actor,initial.id);const resolved=await sessionView(actor,initial.id);
 expect(resolved.agenda?.scope).toBe('my_tasks');expect(resolved.facts.intent).toBe('appointment');expect(resolved.facts.title).toBe('Inspection');
});
it('keeps the suspended request recoverable if an agenda lookup fails',async()=>{
 const initial=await extracted('Book inspection',facts);
 await submitTurn(actor,initial.id,{text:'Show my tasks',expectedVersion:initial.version,clientTurnId:randomUUID()});
 mocks.extract.mockResolvedValue({facts:{...initial.facts,intent:'agenda',agendaScope:'my_tasks'},usage:{requestId:randomUUID(),inputTokens:null,outputTokens:null}});
 await admin.query("UPDATE va_workers SET permissions=permissions||'{\"tasks\":false}'::jsonb WHERE id=$1",[actor.id]);
 await processSession(actor,initial.id);expect((await sessionView(actor,initial.id)).state).toBe('failed');
 await admin.query("UPDATE va_workers SET permissions=permissions-'tasks' WHERE id=$1",[actor.id]);
 await processSession(actor,initial.id);const resumed=await sessionView(actor,initial.id);
 expect(resumed.agenda?.scope).toBe('my_tasks');expect(resumed.facts.intent).toBe('appointment');expect(resumed.facts.title).toBe('Inspection');
});
