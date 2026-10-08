import 'server-only';
import { randomUUID } from 'node:crypto';
import { actorTransaction,pool } from './db';
import { ownedSession,appendTurn } from './sessions';
import type { Actor,Facts,EventSnapshot,BusyInterval } from './domain';
import { getCalendarProvider,getLanguageProvider } from './providers';
import { validateSchedule,overlaps,busyMessage } from './scheduling';
import { config } from './config';
import { hash } from './crypto';
import { ProviderError } from './errors';

export async function connectionFor(actor:Actor) {
 const {rows}=await pool().query(`SELECT c.*,w.config_version FROM private.va_calendar_connections c
   JOIN public.va_workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=$1 AND c.status<>'disabled'`,[actor.workspaceId]);
 if(!rows[0]||rows[0].status!=='connected') throw new ProviderError('CALENDAR_RECONNECT_REQUIRED');return rows[0];
}
export async function localBusy(calendarId:string,snapshot:EventSnapshot,excludeAttempt:string|null=null):Promise<BusyInterval[]> {
 const {rows}=await pool().query(`SELECT starts_at,ends_at FROM public.va_attempts WHERE calendar_id=$1
   AND status IN ('reserved','writing','unknown','succeeded') AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz
   AND ($4::uuid IS NULL OR id<>$4)`,[calendarId,snapshot.start,snapshot.end,excludeAttempt]);
 return rows.map(r=>({start:r.starts_at.toISOString(),end:r.ends_at.toISOString()}));
}
export async function processSession(actor:Actor,id:string,extract=true) {
 const processingStarted=performance.now();
 const token=randomUUID();
 const claimed=await actorTransaction(actor,async db=>{
   const s=await ownedSession(db,actor,id,true);
   if(!['captured','failed'].includes(s.state)||s.content_redacted_at||(s.processing_until&&s.processing_until.getTime()>Date.now())) return null;
   const turns=await db.query("SELECT body,created_at FROM public.va_turns WHERE session_id=$1 AND speaker='user' ORDER BY turn_no DESC LIMIT 1",[id]);
   await db.query("UPDATE public.va_sessions SET processing_token=$2,processing_until=now()+interval '45 seconds' WHERE id=$1",[id,token]);
   return {facts:s.facts as Facts,version:s.version as number,text:turns.rows[0]?.body??'',createdAt:(turns.rows[0]?.created_at??s.created_at).toISOString()};
 });
 if(!claimed) return;
 let facts=claimed.facts;
 try {
   if(extract) {
     const result=await getLanguageProvider().extract(claimed.text,claimed.facts,claimed.createdAt);facts=result.facts;
     await pool().query(`INSERT INTO public.va_usage_events(workspace_id,worker_id,session_id,provider,provider_request_id,operation,input_tokens,output_tokens,cost_status,estimated_cost_aed)
       VALUES($1,$2,$3,$4,$5,'extract',$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[actor.workspaceId,actor.id,id,config().mode==='demo'&&process.env.LANGUAGE_PROVIDER!=='groq'?'simulated':'groq',result.usage.requestId,result.usage.inputTokens,result.usage.outputTokens,config().mode==='demo'&&process.env.LANGUAGE_PROVIDER!=='groq'?'not_applicable':'unknown',config().mode==='demo'&&process.env.LANGUAGE_PROVIDER!=='groq'?0:null]);
   }
   facts={...facts,timeZone:'Asia/Dubai'};
   const valid=validateSchedule(facts);let reply=valid.question;let ready:EventSnapshot|null=null;let connection:Awaited<ReturnType<typeof connectionFor>>|null=null;
   if(valid.snapshot) {
     connection=await connectionFor(actor);const provider=await getCalendarProvider(actor);
     const [providerBusy,reservations]=await Promise.all([
       provider.queryBusy(connection.calendar_id,valid.snapshot.start,valid.snapshot.end),localBusy(connection.calendar_id,valid.snapshot),
     ]);
     const busy=[...providerBusy,...reservations];
     const clash=busy.find(b=>overlaps({start:valid.snapshot!.start,end:valid.snapshot!.end},b));
     if(clash) reply=busyMessage(clash);else {ready=valid.snapshot;reply='Everything is ready. Review the details below, then tap Confirm appointment when you are happy with them.';}
   }
   await actorTransaction(actor,async db=>{
     const current=await ownedSession(db,actor,id,true);
     if(current.version!==claimed.version||current.processing_token!==token||!['captured','failed'].includes(current.state)) return;
     const nextVersion=claimed.version+1;let state=ready?'ready':'clarifying';
     if(facts.intent==='note') {
       const {rows}=await db.query("SELECT body FROM public.va_turns WHERE session_id=$1 AND speaker='user' ORDER BY turn_no",[id]);
       const body=rows.map(r=>r.body).filter(Boolean).join('\n');
       await db.query(`INSERT INTO public.va_records(workspace_id,worker_id,session_id,kind,title,body,outcome)
         VALUES($1,$2,$3,'note',$4,$5,'saved')`,[actor.workspaceId,actor.id,id,facts.title??body.slice(0,100),body]);
       state='note_saved';reply='Saved as a note. No calendar booking was made.';
     }
     if(ready&&connection) {
       const active=await db.query(`SELECT c.calendar_id,w.config_version FROM private.va_calendar_connections c JOIN public.va_workspaces w ON w.id=c.workspace_id
         WHERE c.workspace_id=$1 AND c.status='connected'`,[actor.workspaceId]);
       if(active.rows[0]?.calendar_id!==connection.calendar_id||active.rows[0]?.config_version!==connection.config_version) throw new ProviderError('CALENDAR_CONNECTION_CHANGED');
       await db.query("UPDATE public.va_proposals SET status='superseded' WHERE session_id=$1 AND status='ready'",[id]);
       const max=await db.query('SELECT coalesce(max(version),0)+1 AS version FROM public.va_proposals WHERE session_id=$1',[id]);
       const version=max.rows[0].version;const snapshotHash=hash({snapshot:ready,workerId:actor.id,sessionId:id,version,sessionVersion:nextVersion,calendarId:connection.calendar_id,configVersion:connection.config_version});
       await db.query(`INSERT INTO public.va_proposals(workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,time_zone,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '5 minutes')`,[actor.workspaceId,actor.id,id,version,nextVersion,connection.config_version,connection.calendar_id,JSON.stringify(ready),snapshotHash,ready.start,ready.end,ready.timeZone]);
     }
     await appendTurn(db,actor,id,'assistant',reply??'Add a little more detail to continue.');
     await db.query(`WITH updated AS (UPDATE public.va_sessions SET facts=$2,state=$3,version=$4,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1 RETURNING id)
       INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail) SELECT $5,$6,id,'conversation.processed',$7::jsonb FROM updated`,[id,JSON.stringify(facts),state,nextVersion,actor.workspaceId,actor.id,{userCode:actor.userCode??'worker',alias:actor.displayName,sessionId:id,status:state,processingMsBeforeCommit:Math.round(performance.now()-processingStarted)}]);
   });
 } catch(error) {
   await actorTransaction(actor,async db=>{
     const s=await ownedSession(db,actor,id,true);if(s.processing_token!==token||s.version!==claimed.version) return;
     const message=error instanceof ProviderError&&error.code.startsWith('CALENDAR')?'Calendar access or availability could not be verified. Your request is saved. Retry, edit the details, or save it as a note.':'The assistant could not finish this request. Your words are saved. Retry or enter the details using Edit.';
     await appendTurn(db,actor,id,'assistant',message);
     await db.query(`WITH updated AS (UPDATE public.va_sessions SET facts=$2,state='failed',version=version+1,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1 RETURNING id)
     INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail) SELECT $3,$4,id,'conversation.processing_failed',$5::jsonb FROM updated`,[id,JSON.stringify(facts),actor.workspaceId,actor.id,{userCode:actor.userCode??'worker',alias:actor.displayName,sessionId:id,errorCode:error instanceof ProviderError?error.code:'PROCESSING_FAILED',processingMsBeforeCommit:Math.round(performance.now()-processingStarted)}]);
   });
 }
}
