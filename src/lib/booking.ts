import 'server-only';
import { randomUUID } from 'node:crypto';
import { actorTransaction,pool } from './db';
import { idempotent,ownedSession,appendTurn } from './sessions';
import { connectionFor,localBusy } from './conversation';
import { getCalendarProvider } from './providers';
import { sameSnapshot } from './providers/calendar';
import { overlaps } from './scheduling';
import { AppError,ProviderError } from './errors';
import { actionQuota,refreshActionQuota,touchAction,finishAction } from './action-quota';
import type { Actor,EventSnapshot,CalendarProvider,CalendarEvent } from './domain';
type AttemptRow={id:string;workspace_id:string;worker_id:string;session_id:string;proposal_id:string;calendar_id:string;event_id:string;intent_hash:string;status:string;recovery_generation:number;recovery_token:string|null;expires_at:Date;config_version:number;snapshot:EventSnapshot};
async function attempt(actor:Actor,id:string):Promise<AttemptRow> {
 const {rows}=await pool().query(`SELECT a.*,p.snapshot,p.expires_at,p.config_version FROM public.va_attempts a JOIN public.va_proposals p ON p.id=a.proposal_id
   WHERE a.id=$1 AND a.worker_id=$2 AND a.workspace_id=$3`,[id,actor.id,actor.workspaceId]);
 if(!rows[0]) throw new AppError('NOT_FOUND','This booking could not be found.',404);return rows[0];
}
export async function reserveBooking(actor:Actor,proposalId:string,input:{proposalVersion:number;snapshotHash:string;idempotencyKey:string}) {
 await refreshActionQuota(actor);
 return actorTransaction(actor,async db=>{
   // Quota comes before idempotency/session locks; timeout charging commits even if this request rejects.
   await actionQuota(db,actor);
   const old=await idempotent(db,actor,'confirm',input.idempotencyKey,{proposalId,version:input.proposalVersion,hash:input.snapshotHash});
   if(old) return {id:old.resource_id as string,created:false};
   const first=await db.query('SELECT session_id FROM public.va_proposals WHERE id=$1 AND worker_id=$2 AND workspace_id=$3',[proposalId,actor.id,actor.workspaceId]);
   if(!first.rows[0]) throw new AppError('NOT_FOUND','This confirmation could not be found.',404);
   // An already authorized attempt remains available after quota exhaustion or an admin reset.
   const authorized=await db.query('SELECT id FROM public.va_attempts WHERE proposal_id=$1',[proposalId]);
   if(!authorized.rowCount) await touchAction(db,actor,first.rows[0].session_id);
   const s=await ownedSession(db,actor,first.rows[0].session_id,true);
   const {rows}=await db.query('SELECT * FROM public.va_proposals WHERE id=$1 FOR UPDATE',[proposalId]);const p=rows[0];
   if(p.version!==input.proposalVersion||p.snapshot_hash!==input.snapshotHash) throw new AppError('STALE_PROPOSAL','Review the latest confirmation card.',409);
   // Re-read after the session lock: administrators bypass quota serialization.
   const existing=await db.query('SELECT id FROM public.va_attempts WHERE proposal_id=$1',[proposalId]);
   let id=existing.rows[0]?.id as string|undefined;
   if(!id) {
     if(p.status!=='ready'||p.session_version!==s.version||s.state!=='ready') throw new AppError('STALE_PROPOSAL','This card has changed. Review the latest request.',409);
     if(p.expires_at.getTime()<=Date.now()||p.starts_at.getTime()<=Date.now()) throw new AppError('EXPIRED_PROPOSAL','This card has expired. Edit or refresh the request to check availability again.',410);
     const connection=await db.query(`SELECT c.calendar_id,w.config_version FROM private.va_calendar_connections c JOIN public.va_workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=$1 AND c.status='connected'`,[actor.workspaceId]);
     if(connection.rows[0]?.calendar_id!==p.calendar_id||connection.rows[0]?.config_version!==p.config_version) throw new AppError('CALENDAR_CHANGED','Calendar access changed. Refresh this request.',409);
     id=randomUUID();
     await db.query(`INSERT INTO public.va_attempts(id,workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at,time_zone)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,actor.workspaceId,actor.id,s.id,proposalId,input.idempotencyKey,p.snapshot_hash,p.calendar_id,'vc'+id.replaceAll('-',''),p.starts_at,p.ends_at,p.time_zone]);
     await db.query("UPDATE public.va_proposals SET status='consumed' WHERE id=$1",[proposalId]);
     await db.query("UPDATE public.va_sessions SET state='confirming',version=version+1,processing_token=NULL,processing_until=NULL,updated_at=now() WHERE id=$1",[s.id]);
     await finishAction(db,actor,s.id,'confirmed');
   }
   await db.query("UPDATE public.va_idempotency SET status='completed',resource_id=$4,response=$5 WHERE worker_id=$1 AND operation=$2 AND idempotency_key=$3",[actor.id,'confirm',input.idempotencyKey,id,JSON.stringify({attemptId:id,sessionId:s.id})]);
   return {id,created:!existing.rowCount};
 });
}
function verifies(row:AttemptRow,event:CalendarEvent|null) { return !!event&&event.id===row.event_id&&event.status==='confirmed'&&event.intentHash===row.intent_hash&&sameSnapshot(row.snapshot,event); }
async function complete(actor:Actor,row:AttemptRow,generation:number,event:CalendarEvent,leaseToken?:string) {
 if(!verifies(row,event)) throw new ProviderError('CALENDAR_EVENT_MISMATCH',true);
 return actorTransaction(actor,async db=>{
   const s=await ownedSession(db,actor,row.session_id,true);
   const updated=await db.query(`UPDATE public.va_attempts SET status='succeeded',resolved_at=now(),error_code=NULL,updated_at=now(),recovery_token=NULL,recovery_lease_until=NULL
     WHERE id=$1 AND worker_id=$2 AND status IN ('writing','unknown') AND recovery_generation=$3
       AND ($4::uuid IS NULL OR recovery_token=$4) RETURNING id`,[row.id,actor.id,generation,leaseToken??null]);
   if(!updated.rowCount) return false;
   await db.query(`INSERT INTO public.va_records(workspace_id,worker_id,session_id,kind,title,location,starts_at,ends_at,time_zone,booking_attempt_id,outcome)
     VALUES($1,$2,$3,'event',$4,$5,$6,$7,$8,$9,'booked')`,[actor.workspaceId,actor.id,s.id,row.snapshot.title,row.snapshot.location,row.snapshot.start,row.snapshot.end,row.snapshot.timeZone,row.id]);
   await db.query("UPDATE public.va_sessions SET state='booked',version=version+1,updated_at=now() WHERE id=$1",[s.id]);
   await appendTurn(db,actor,s.id,'assistant','Your appointment is booked. The calendar has confirmed it.');return true;
 });
}
async function markFailure(actor:Actor,row:AttemptRow,status:'blocked'|'failed'|'unknown',code:string,from:string,generation:number) {
 await actorTransaction(actor,async db=>{
   await ownedSession(db,actor,row.session_id,true);
   const changed=await db.query(`UPDATE public.va_attempts SET status=$3,error_code=$4,resolved_at=CASE WHEN $3='unknown' THEN NULL ELSE now() END,updated_at=now()
     WHERE id=$1 AND worker_id=$2 AND status=$5 AND recovery_generation=$6 RETURNING id`,[row.id,actor.id,status,code,from,generation]);
   if(!changed.rowCount)return;
   await db.query('UPDATE public.va_sessions SET state=$2,version=version+1,updated_at=now() WHERE id=$1',[row.session_id,status==='unknown'?'booking_unknown':'failed']);
   await appendTurn(db,actor,row.session_id,'assistant',status==='unknown'?'The booking status is uncertain. Do not create another booking. Use Check booking status to verify this same event.':status==='blocked'?'That time is now busy. No booking was sent. Edit the request to choose another time.':'The booking was not sent or was definitively rejected. Review the request and create a fresh confirmation card.');
 });
}
export async function executeBooking(actor:Actor,id:string,provided?:CalendarProvider) {
 const row=await attempt(actor,id);if(row.status!=='reserved')return row.session_id;
 let dispatched=false;
 try {
   if(row.expires_at.getTime()<=Date.now()) {await markFailure(actor,row,'failed','EXPIRED_PROPOSAL','reserved',row.recovery_generation);return row.session_id;}
   const connection=await connectionFor(actor);if(connection.calendar_id!==row.calendar_id||connection.config_version!==row.config_version) throw new ProviderError('CALENDAR_CHANGED');
   const provider=provided??await getCalendarProvider(actor);
   const [providerBusy,reservations]=await Promise.all([
     provider.queryBusy(row.calendar_id,row.snapshot.start,row.snapshot.end),localBusy(row.calendar_id,row.snapshot,row.id),
   ]);
   const busy=[...providerBusy,...reservations];
   if(busy.some(b=>overlaps({start:row.snapshot.start,end:row.snapshot.end},b))) {await markFailure(actor,row,'blocked','BUSY','reserved',row.recovery_generation);return row.session_id;}
   dispatched=await actorTransaction(actor,async db=>{
     await ownedSession(db,actor,row.session_id,true);
     const result=await db.query(`UPDATE public.va_attempts a SET status='writing',dispatch_at=now(),updated_at=now()
       FROM public.va_proposals p,public.va_workspaces w,private.va_calendar_connections c
       WHERE a.id=$1 AND a.worker_id=$2 AND a.status='reserved' AND p.id=a.proposal_id AND p.expires_at>now()
       AND a.starts_at>now() AND w.id=a.workspace_id AND p.config_version=w.config_version AND c.workspace_id=w.id
       AND c.calendar_id=a.calendar_id AND c.status='connected' RETURNING a.id`,[id,actor.id]);return !!result.rowCount;
   });
   if(!dispatched) {await markFailure(actor,row,'failed','DISPATCH_EXPIRED','reserved',row.recovery_generation);return row.session_id;}
   const event=await provider.insert(row.calendar_id,row.event_id,row.snapshot,row.intent_hash);
   await complete(actor,row,row.recovery_generation,event);
 } catch(error) {
   const ambiguous=dispatched&&(!(error instanceof ProviderError)||error.ambiguous);
   await markFailure(actor,row,ambiguous?'unknown':'failed',error instanceof ProviderError?error.code:'UNAVAILABLE',dispatched?'writing':'reserved',row.recovery_generation);
 }
 return row.session_id;
}
export async function recoverBooking(actor:Actor,id:string,provided?:CalendarProvider) {
 let row=await attempt(actor,id);
 if(row.status==='reserved') return executeBooking(actor,id,provided);
 if(!['writing','unknown'].includes(row.status)) return row.session_id;
 const token=randomUUID();
 const claimed=await actorTransaction(actor,async db=>{
   await ownedSession(db,actor,row.session_id,true);
   const {rows}=await db.query(`UPDATE public.va_attempts SET status='unknown',recovery_token=$3,recovery_generation=recovery_generation+1,recovery_lease_until=now()+interval '30 seconds',updated_at=now()
     WHERE id=$1 AND worker_id=$2 AND status IN ('writing','unknown') AND (recovery_lease_until IS NULL OR recovery_lease_until<now()) RETURNING recovery_generation`,[id,actor.id,token]);
   if(rows[0]) await db.query("UPDATE public.va_sessions SET state='booking_unknown',updated_at=now() WHERE id=$1",[row.session_id]);
   return rows[0]?.recovery_generation as number|undefined;
 });
 if(claimed===undefined)return row.session_id;
 row=await attempt(actor,id);
 try {
   const provider=provided??await getCalendarProvider(actor);const event=await provider.readCreated(row.calendar_id,row.event_id);
   if(verifies(row,event)) await complete(actor,row,claimed,event!,token);
   else await pool().query(`UPDATE public.va_attempts SET error_code=$3 WHERE id=$1 AND recovery_token=$2 AND recovery_generation=$4 AND status='unknown'`,[id,token,event?'READBACK_MISMATCH':'READBACK_NOT_FOUND',claimed]);
 } catch {
   await pool().query("UPDATE public.va_attempts SET error_code='READBACK_UNAVAILABLE' WHERE id=$1 AND recovery_token=$2 AND recovery_generation=$3 AND status='unknown'",[id,token,claimed]);
 } finally {
   await pool().query('UPDATE public.va_attempts SET recovery_token=NULL,recovery_lease_until=NULL WHERE id=$1 AND recovery_token=$2 AND recovery_generation=$3',[id,token,claimed]);
 }
 return row.session_id;
}
