import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { actorTransaction,workerRead } from './db';
import type { Actor,Facts,SessionView,DashboardItem } from './domain';
import { emptyFacts } from './domain';
import { hash } from './crypto';
import { AppError } from './errors';
import { createTaskInTransaction,resolveTaskDraftInTransaction } from './workspace-modules';

export async function ownedSession(db:PoolClient,actor:Actor,id:string,lock=false) {
  const {rows}=await db.query(`SELECT * FROM public.va_sessions WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 ${lock?'FOR UPDATE':''}`,[id,actor.id,actor.workspaceId]);
  if(!rows[0]) throw new AppError('NOT_FOUND','This conversation could not be found.',404);
  return rows[0];
}
export async function idempotent(db:PoolClient,actor:Actor,operation:string,key:string,payload:unknown) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.id+':'+operation+':'+key]);
  const {rows}=await db.query('SELECT * FROM public.va_idempotency WHERE worker_id=$1 AND operation=$2 AND idempotency_key=$3',[actor.id,operation,key]);
  const payloadHash=hash(payload);
  if(rows[0]) {
    if(rows[0].payload_hash!==payloadHash) throw new AppError('REPLAY_MISMATCH','This request key was already used for different content.',409);
    return rows[0];
  }
  await db.query(`INSERT INTO public.va_idempotency(workspace_id,worker_id,operation,idempotency_key,payload_hash)
    VALUES($1,$2,$3,$4,$5)`,[actor.workspaceId,actor.id,operation,key,payloadHash]);
  return null;
}
async function finishKey(db:PoolClient,actor:Actor,operation:string,key:string,id:string) {
  await db.query(`UPDATE public.va_idempotency SET status='completed',resource_id=$4,response=$5,updated_at=now()
    WHERE worker_id=$1 AND operation=$2 AND idempotency_key=$3`,[actor.id,operation,key,id,JSON.stringify({sessionId:id})]);
}
export async function appendTurn(db:PoolClient,actor:Actor,id:string,speaker:'user'|'assistant',body:string,clientId:string|null=null,source:string|null=null) {
  await db.query(`INSERT INTO public.va_turns(workspace_id,worker_id,session_id,turn_no,speaker,body,client_turn_id,source)
    SELECT $1,$2,$3,coalesce(max(turn_no),0)+1,$4,$5,$6,$7 FROM public.va_turns WHERE session_id=$3`,[actor.workspaceId,actor.id,id,speaker,body,clientId,source]);
}
function requireEditable(row:Record<string,unknown>,version:number) {
  if(row.version!==version) throw new AppError('STALE_VERSION','This conversation changed. Reload it before continuing.',409);
  if(['confirming','booked','booking_unknown','note_saved','task_saved'].includes(String(row.state))) throw new AppError('SESSION_LOCKED','This request is already saved or has a booking in progress.',409);
  if(row.content_redacted_at) throw new AppError('CONTENT_EXPIRED','This conversation has expired. Start a new capture.',410);
}
export async function capture(actor:Actor,input:{text:string;source:string;clientCaptureId:string}) {
  return actorTransaction(actor,async db=>{
    const old=await idempotent(db,actor,'capture',input.clientCaptureId,{text:input.text,source:input.source});
    if(old) return {id:old.resource_id as string,process:false};
    const id=randomUUID();
    await db.query(`INSERT INTO public.va_sessions(id,workspace_id,worker_id,facts) VALUES($1,$2,$3,$4)`,[id,actor.workspaceId,actor.id,JSON.stringify(emptyFacts())]);
    await appendTurn(db,actor,id,'user',input.text,input.clientCaptureId,input.source);
    await finishKey(db,actor,'capture',input.clientCaptureId,id);
    return {id,process:true};
  });
}
export async function submitTurn(actor:Actor,id:string,input:{text:string;source?:'typed'|'browser_voice';expectedVersion:number;clientTurnId:string}) {
  return actorTransaction(actor,async db=>{
    const old=await idempotent(db,actor,'turn',input.clientTurnId,{id,text:input.text,source:input.source??'typed',version:input.expectedVersion});
    if(old) return {id,process:false};
    const session=await ownedSession(db,actor,id,true);requireEditable(session,input.expectedVersion);
    await db.query("UPDATE public.va_proposals SET status='superseded' WHERE session_id=$1 AND status='ready'",[id]);
    await appendTurn(db,actor,id,'user',input.text,input.clientTurnId,input.source??'typed');
    await db.query("UPDATE public.va_sessions SET state='captured',version=version+1,assistant_view=NULL,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1",[id]);
    await finishKey(db,actor,'turn',input.clientTurnId,id);
    return {id,process:true};
  });
}
export async function editFacts(actor:Actor,id:string,input:{facts:Partial<Facts>;expectedVersion:number;clientActionId:string}) {
  return actorTransaction(actor,async db=>{
    const old=await idempotent(db,actor,'edit',input.clientActionId,{id,facts:input.facts,version:input.expectedVersion});
    if(old) return {id,process:false};
    const session=await ownedSession(db,actor,id,true);requireEditable(session,input.expectedVersion);
    await db.query("UPDATE public.va_proposals SET status='superseded' WHERE session_id=$1 AND status='ready'",[id]);
    const facts={...emptyFacts(),...session.facts,...input.facts,timeZone:'Asia/Dubai',ambiguities:[]};
    if(facts.locationNotApplicable) facts.location=null;
    await appendTurn(db,actor,id,'user','Updated the request details.',input.clientActionId,'typed');
    await db.query("UPDATE public.va_sessions SET facts=$2,state='captured',version=version+1,assistant_view=NULL,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1",[id,JSON.stringify(facts)]);
    await finishKey(db,actor,'edit',input.clientActionId,id);
    return {id,process:true};
  });
}
export async function saveNote(actor:Actor,id:string,input:{expectedVersion:number;clientActionId:string}) {
  return actorTransaction(actor,async db=>{
    const old=await idempotent(db,actor,'note',input.clientActionId,{id,version:input.expectedVersion});
    if(old) return {id};
    const session=await ownedSession(db,actor,id,true);requireEditable(session,input.expectedVersion);
    const {rows}=await db.query("SELECT body FROM public.va_turns WHERE session_id=$1 AND speaker='user' ORDER BY turn_no",[id]);
    const body=session.facts.intent==='note'&&(session.facts.noteText||session.facts.title)?(session.facts.noteText||session.facts.title):rows.map(r=>r.body).filter(Boolean).join('\n');
    await db.query(`INSERT INTO public.va_records(workspace_id,worker_id,session_id,kind,title,body,outcome)
      VALUES($1,$2,$3,'note',$4,$5,'saved')`,[actor.workspaceId,actor.id,id,session.facts.title??body.slice(0,100),body]);
    await db.query("UPDATE public.va_proposals SET status='superseded' WHERE session_id=$1 AND status='ready'",[id]);
    await db.query("UPDATE public.va_sessions SET state='note_saved',version=version+1,assistant_view=NULL,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1",[id]);
    await appendTurn(db,actor,id,'assistant','Note saved.');
    await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,session_id,event_type,detail) VALUES($1,$2,$3,$3,'note.confirmed',$4)`,[actor.workspaceId,actor.id,id,{userCode:actor.userCode??'worker',alias:actor.displayName,decision:'confirmed',sessionVersion:input.expectedVersion}]);
    await finishKey(db,actor,'note',input.clientActionId,id);return {id};
  });
}
export async function confirmTask(actor:Actor,id:string,input:{expectedVersion:number;clientActionId:string}) {
 return actorTransaction(actor,async db=>{
  const old=await idempotent(db,actor,'task',input.clientActionId,{id,version:input.expectedVersion});
  if(old)return {id};
  const session=await ownedSession(db,actor,id,true);requireEditable(session,input.expectedVersion);
  const draft=session.assistant_view?.taskDraft;
  if(session.state!=='task_ready'||session.facts.intent!=='task'||!draft)throw new AppError('NOT_READY','Review a complete task before confirming.',409);
  // Recheck assignment and current permissions at the moment of confirmation.
  const resolved=await resolveTaskDraftInTransaction(db,actor,draft);
  await createTaskInTransaction(db,actor,{...resolved,sourceSessionId:id});
  await db.query("UPDATE public.va_sessions SET state='task_saved',version=version+1,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1",[id]);
  await appendTurn(db,actor,id,'assistant',`Task assigned to ${resolved.assigneeUserCode}.`);
  await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,session_id,event_type,detail,content)
    VALUES($1,$2,$3,$3,'task.confirmed',$4,$5)`,[actor.workspaceId,actor.id,id,{userCode:actor.userCode??'worker',alias:actor.displayName,decision:'confirmed'},{taskDraft:resolved}]);
  await finishKey(db,actor,'task',input.clientActionId,id);return {id};
 });
}
export async function sessionView(actor:Actor,id:string):Promise<SessionView> {
  return workerRead(actor,async db=>{
    // One database snapshot keeps the conversation, proposal and attempt consistent,
    // and avoids four sequential network round trips on every assistant response.
    const {rows}=await db.query(`SELECT s.*,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'speaker',t.speaker,'body',t.body) ORDER BY t.turn_no)
        FROM public.va_turns t WHERE t.session_id=s.id),'[]'::jsonb) AS turns,
      (SELECT jsonb_build_object('id',p.id,'version',p.version,'snapshot',p.snapshot,'snapshotHash',p.snapshot_hash,'expiresAt',p.expires_at)
        FROM public.va_proposals p WHERE p.session_id=s.id AND p.status='ready' ORDER BY p.version DESC LIMIT 1) AS proposal,
      (SELECT jsonb_build_object('id',a.id,'status',a.status,'errorCode',a.error_code)
        FROM public.va_attempts a WHERE a.session_id=s.id ORDER BY a.created_at DESC LIMIT 1) AS attempt
      FROM public.va_sessions s WHERE s.id=$1 AND s.worker_id=$2 AND s.workspace_id=$3`,[id,actor.id,actor.workspaceId]);
    const s=rows[0];
    if(!s)throw new AppError('NOT_FOUND','This conversation could not be found.',404);
    return {id,state:s.state,version:s.version,facts:{...emptyFacts(),...s.facts},createdAt:s.created_at.toISOString(),contentExpired:!!s.content_redacted_at,
      turns:s.turns,agenda:s.content_redacted_at?null:s.assistant_view?.agenda??null,taskDraft:s.content_redacted_at?null:s.assistant_view?.taskDraft??null,proposal:s.proposal?{...s.proposal,expiresAt:new Date(s.proposal.expiresAt).toISOString()}:null,attempt:s.attempt};
  });
}
export async function dashboard(actor:Actor,type:string,cursor?:string):Promise<{items:DashboardItem[];nextCursor:string|null}> {
 let after:{anchor:string;rank:number;at:number;id:string}|null=null;
 if(cursor){try{
  if(cursor.length>512)throw new Error();after=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(!after||!Number.isFinite(Date.parse(after.anchor))||!Number.isInteger(after.rank)||after.rank<0||after.rank>3||!Number.isFinite(after.at)||! /^[0-9a-f-]{36}$/.test(after.id))throw new Error();
 }catch{throw new AppError('INVALID_CURSOR','Please reload the list.',422);}}
 const anchor=after?.anchor??new Date().toISOString();
 return actorTransaction(actor,async(db,member)=>{
  const canTasks=member.role==='admin'||member.permissions.tasks!==false,canCalendar=member.role==='admin'||member.permissions.calendar!==false;
  const {rows}=await db.query(`WITH items AS (
   SELECT r.id,r.session_id,r.kind,r.title,r.body,r.outcome AS status,r.starts_at,r.created_at,r.content_redacted_at
    FROM public.va_records r WHERE r.workspace_id=$1 AND r.worker_id=$2 AND (r.kind<>'event' OR $4::boolean)
   UNION ALL
   SELECT s.id,s.id,'request',coalesce(s.facts->>'title','New request'),
    (SELECT body FROM public.va_turns t WHERE t.session_id=s.id AND speaker='user' ORDER BY turn_no LIMIT 1),s.state,NULL,s.created_at,s.content_redacted_at
    FROM public.va_sessions s WHERE s.workspace_id=$1 AND s.worker_id=$2 AND s.facts->>'intent'<>'agenda'
    AND NOT EXISTS(SELECT 1 FROM public.va_records r WHERE r.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM public.va_tasks t WHERE t.source_session_id=s.id)
   UNION ALL
   SELECT t.id,CASE WHEN t.worker_id=$2 THEN t.source_session_id ELSE NULL::uuid END,'task',t.title,NULL,t.status,t.due_at,t.created_at,NULL::timestamptz
    FROM public.va_tasks t WHERE t.workspace_id=$1 AND (t.worker_id=$2 OR t.assignee_worker_id=$2) AND $3::boolean
   UNION ALL
   SELECT e.id,NULL::uuid,'event',e.title,NULL,e.status,e.starts_at,e.created_at,NULL::timestamptz
    FROM private.va_internal_events e WHERE e.workspace_id=$1 AND e.status='confirmed' AND $4::boolean
    AND NOT EXISTS(SELECT 1 FROM public.va_attempts a WHERE a.workspace_id=$1 AND a.event_id=e.event_id AND a.status='succeeded')
  ), ranked AS (
   SELECT *,CASE WHEN (kind='event' AND starts_at >= $5::timestamptz) OR (kind='task' AND status<>'done' AND starts_at IS NOT NULL) THEN 0
    WHEN kind='task' AND status<>'done' THEN 1 WHEN kind='request' AND status NOT IN ('booked','note_saved','task_saved') THEN 2 ELSE 3 END AS sort_rank FROM items
  ), sorted AS (
   SELECT *,CASE WHEN sort_rank=0 THEN extract(epoch FROM starts_at) WHEN sort_rank=1 THEN extract(epoch FROM created_at) ELSE -extract(epoch FROM created_at) END AS sort_at FROM ranked
  ) SELECT * FROM sorted WHERE ($6='all' OR kind=$6) AND ($7::integer IS NULL OR (sort_rank,sort_at,id)>($7::integer,$8::numeric,$9::uuid))
  ORDER BY sort_rank,sort_at,id LIMIT 21`,[actor.workspaceId,actor.id,canTasks,canCalendar,anchor,type,after?.rank??null,after?.at??null,after?.id??null]);
  const visible=rows.slice(0,20),last=visible.at(-1);
  return {items:visible.map(r=>({id:r.id,sessionId:r.session_id,kind:r.kind,title:r.content_redacted_at?'Content expired':r.title??'Untitled',body:r.body,status:r.status,startsAt:r.starts_at?.toISOString()??null,createdAt:r.created_at.toISOString(),contentExpired:!!r.content_redacted_at})),
   nextCursor:rows.length>20&&last?Buffer.from(JSON.stringify({anchor,rank:last.sort_rank,at:Number(last.sort_at),id:last.id})).toString('base64url'):null};
 });
}
