import 'server-only';
import type { PoolClient } from 'pg';
import { actorTransaction } from './db';
import type { Actor } from './domain';
import { AppError } from './errors';

export const ACTION_LIMIT = 3;
export const ACTION_IDLE_SECONDS = 180;
export type ActionQuota = {limit:number;used:number;active:number;remaining:number;exhausted:boolean;admin:boolean;generation:number;resetAt:string|null};
export type HQUser = ActionQuota & {id:string;userCode:string|null;displayName:string;enabled:boolean;role:'user';permissions:Record<string,boolean>};
type QuotaRow={generation:number;used:number;reset_at:Date|null};
const limitError=()=>new AppError('ACTION_LIMIT_REACHED','Request limit reached. Contact your admin.',429);
const expiredError=()=>new AppError('ACTION_EXPIRED','This request ended after 3 minutes of inactivity. Start a new chat if you have requests remaining.',409);
const exempt:ActionQuota={limit:ACTION_LIMIT,used:0,active:0,remaining:ACTION_LIMIT,exhausted:false,admin:true,generation:0,resetAt:null};

// Always take this lock before session locks. It serializes allocation, expiry, confirmation and reset.
async function lockedQuota(db:PoolClient,actor:Actor):Promise<QuotaRow|null>{
 const member=await db.query('SELECT role FROM public.va_workers WHERE workspace_id=$1 AND id=$2 AND active FOR SHARE',[actor.workspaceId,actor.id]);
 if(!member.rowCount)throw new AppError('UNAUTHORIZED','Please sign in again.',401);
 if(member.rows[0].role==='admin')return null;
 await db.query('INSERT INTO private.va_action_quotas(workspace_id,worker_id) VALUES($1,$2) ON CONFLICT(worker_id) DO NOTHING',[actor.workspaceId,actor.id]);
 return (await db.query<QuotaRow>('SELECT generation,used,reset_at FROM private.va_action_quotas WHERE workspace_id=$1 AND worker_id=$2 FOR UPDATE',[actor.workspaceId,actor.id])).rows[0];
}
async function audit(db:PoolClient,actor:Actor,sessionId:string|null,event:string,detail:Record<string,unknown>){
 await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,session_id,event_type,detail)
 SELECT $1,$2,coalesce($3::uuid,$2::uuid),$3,$4,$5::jsonb||jsonb_build_object('userCode',user_code,'alias',$6::text) FROM public.va_workers WHERE id=$2`,[actor.workspaceId,actor.id,sessionId,event,JSON.stringify(detail),actor.displayName]);
}
async function summary(db:PoolClient,actor:Actor,row:QuotaRow):Promise<ActionQuota>{
 const active=Number((await db.query("SELECT count(*) FROM private.va_actions WHERE worker_id=$1 AND generation=$2 AND status='active'",[actor.id,row.generation])).rows[0].count);
 const remaining=Math.max(0,ACTION_LIMIT-row.used-active);
 return {limit:ACTION_LIMIT,used:row.used,active,remaining,exhausted:row.used>=ACTION_LIMIT,admin:false,generation:row.generation,resetAt:row.reset_at?.toISOString()??null};
}
async function closeDraft(db:PoolClient,actor:Actor,sessionId:string,state:'action_expired'|'cancelled'){
 await db.query("UPDATE public.va_proposals SET status='expired' WHERE session_id=$1 AND worker_id=$2 AND status='ready'",[sessionId,actor.id]);
 const changed=await db.query(`UPDATE public.va_sessions SET state=$3,version=version+1,updated_at=now(),processing_token=NULL,processing_until=NULL,assistant_view=NULL
 WHERE id=$1 AND worker_id=$2 AND state IN ('captured','clarifying','ready','note_ready','task_ready','failed') RETURNING id`,[sessionId,actor.id,state]);
 if(changed.rowCount&&state==='action_expired')await db.query(`INSERT INTO public.va_turns(workspace_id,worker_id,session_id,turn_no,speaker,body)
 SELECT $1,$2,$3,coalesce(max(turn_no),0)+1,'assistant','This request ended after 3 minutes of inactivity. Start a new chat if you have requests remaining.' FROM public.va_turns WHERE session_id=$3`,[actor.workspaceId,actor.id,sessionId]);
}
async function expireLocked(db:PoolClient,actor:Actor,row:QuotaRow){
 const stale=await db.query(`SELECT a.session_id,EXISTS(SELECT 1 FROM public.va_attempts b WHERE b.session_id=a.session_id AND b.status IN ('reserved','writing','unknown','succeeded')) AS confirmed
 FROM private.va_actions a WHERE a.worker_id=$1 AND a.generation=$2 AND a.status='active' AND a.last_user_activity_at<=now()-interval '3 minutes'
 ORDER BY a.session_id FOR UPDATE`,[actor.id,row.generation]);
 for(const action of stale.rows){
  const reason=action.confirmed?'confirmed':'idle_timeout';
  await db.query(`UPDATE private.va_actions SET status=$2,completed_at=now(),completion_reason=$3 WHERE session_id=$1`,[action.session_id,action.confirmed?'completed':'expired',reason]);
  if(!action.confirmed)await closeDraft(db,actor,action.session_id,'action_expired');
  await audit(db,actor,action.session_id,'action.completed',{reason,generation:row.generation});
 }
 if(stale.rowCount){row.used+=stale.rowCount;await db.query('UPDATE private.va_action_quotas SET used=$2 WHERE worker_id=$1',[actor.id,row.used]);}
}

/** Expiry in a caller transaction. Use refreshActionQuota before a mutation that can reject. */
export async function actionQuota(db:PoolClient,actor:Actor):Promise<ActionQuota>{
 const row=await lockedQuota(db,actor);if(!row)return {...exempt};
 await expireLocked(db,actor,row);return summary(db,actor,row);
}
/** Independent commit preserves timeout charging even if a later interaction rejects. */
export async function refreshActionQuota(actor:Actor):Promise<ActionQuota>{return actorTransaction(actor,db=>actionQuota(db,actor));}

export async function startAction(db:PoolClient,actor:Actor,sessionId:string):Promise<void>{
 const row=await lockedQuota(db,actor);if(!row)return;
 const existing=await db.query('SELECT status,generation FROM private.va_actions WHERE session_id=$1 AND worker_id=$2',[sessionId,actor.id]);
 if(existing.rowCount){
  if(existing.rows[0].status==='active'&&existing.rows[0].generation===row.generation)return;
  throw new AppError('ACTION_CLOSED','This request has ended. Start a new chat.',409);
 }
 const state=await db.query('SELECT state FROM public.va_sessions WHERE id=$1 AND worker_id=$2 AND workspace_id=$3',[sessionId,actor.id,actor.workspaceId]);
 if(!state.rowCount)throw new AppError('NOT_FOUND','Request not found.',404);
 if(!['captured','clarifying','ready','note_ready','task_ready','failed'].includes(state.rows[0].state))throw new AppError('ACTION_CLOSED','This request has ended. Start a new chat.',409);
 if((await summary(db,actor,row)).remaining===0)throw limitError();
 await db.query('INSERT INTO private.va_actions(session_id,workspace_id,worker_id,generation) VALUES($1,$2,$3,$4)',[sessionId,actor.workspaceId,actor.id,row.generation]);
 await audit(db,actor,sessionId,'action.started',{generation:row.generation,limit:ACTION_LIMIT});
}

/** Check provider commits without extending the inactivity window. */
export async function assertActionActive(db:PoolClient,actor:Actor,sessionId:string):Promise<void>{
 const row=await lockedQuota(db,actor);if(!row)return;
 let action=(await db.query('SELECT status,generation,last_user_activity_at FROM private.va_actions WHERE session_id=$1 AND worker_id=$2',[sessionId,actor.id])).rows[0];
 if(!action){await startAction(db,actor,sessionId);action=(await db.query('SELECT status,generation,last_user_activity_at FROM private.va_actions WHERE session_id=$1 AND worker_id=$2',[sessionId,actor.id])).rows[0];}
 if(action.status==='expired')throw expiredError();
 if(action.status!=='active'||action.generation!==row.generation)throw new AppError('ACTION_CLOSED','This request has ended. Start a new chat.',409);
 const valid=await db.query("SELECT session_id FROM private.va_actions WHERE session_id=$1 AND status='active' AND last_user_activity_at>now()-interval '3 minutes'",[sessionId]);
 if(!valid.rowCount)throw expiredError();
}

/** Marks only accepted USER activity. Polling, provider replies and HQ views must not call this. */
export async function touchAction(db:PoolClient,actor:Actor,sessionId:string):Promise<void>{
 await assertActionActive(db,actor,sessionId);
 await db.query("UPDATE private.va_actions SET last_user_activity_at=now() WHERE session_id=$1 AND worker_id=$2 AND status='active'",[sessionId,actor.id]);
}

/** Confirmation consumes the action before dispatch; uncertain booking recovery remains available. */
export async function finishAction(db:PoolClient,actor:Actor,sessionId:string,reason:'confirmed'|'completed'|'cancelled'):Promise<void>{
 const row=await lockedQuota(db,actor);if(!row)return;
 const action=(await db.query('SELECT status,generation FROM private.va_actions WHERE session_id=$1 AND worker_id=$2',[sessionId,actor.id])).rows[0];
 // Historical terminal sessions do not retroactively consume quota. New confirmations call touch first.
 if(!action)return;
 if(action.status!=='active')return;
 if(action.generation!==row.generation)throw new AppError('ACTION_CLOSED','This request has ended. Start a new chat.',409);
 await db.query('UPDATE private.va_actions SET status=$2,completed_at=now(),completion_reason=$3 WHERE session_id=$1',[sessionId,reason==='cancelled'?'cancelled':'completed',reason]);
 await db.query('UPDATE private.va_action_quotas SET used=used+1 WHERE worker_id=$1',[actor.id]);
 if(reason==='cancelled')await closeDraft(db,actor,sessionId,'cancelled');
 await audit(db,actor,sessionId,'action.completed',{reason,generation:row.generation});
}

export async function hqUsers(actor:Actor):Promise<HQUser[]>{
 return actorTransaction(actor,async(db,member)=>{
  if(member.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required.',403);
  const users=(await db.query("SELECT id,user_code,display_name,active,permissions FROM public.va_workers WHERE workspace_id=$1 AND role='user' ORDER BY user_code NULLS LAST,id",[actor.workspaceId])).rows;
  const result:HQUser[]=[];
  for(const user of users){
   const target:Actor={...actor,id:user.id,displayName:user.display_name};
   // Disabled users remain visible without impersonating their inactive identity.
   await db.query('INSERT INTO private.va_action_quotas(workspace_id,worker_id) VALUES($1,$2) ON CONFLICT(worker_id) DO NOTHING',[actor.workspaceId,user.id]);
   const row=(await db.query<QuotaRow>('SELECT generation,used,reset_at FROM private.va_action_quotas WHERE worker_id=$1 FOR UPDATE',[user.id])).rows[0];
   await expireLocked(db,target,row);
   result.push({...await summary(db,target,row),id:user.id,userCode:user.user_code,displayName:user.display_name,enabled:user.active,role:'user',permissions:user.permissions});
  }
  return result;
 });
}

export async function resetUserActions(actor:Actor,workerId:string):Promise<ActionQuota>{
 return actorTransaction(actor,async(db,member)=>{
  if(member.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required.',403);
  const user=(await db.query("SELECT id,display_name,role FROM public.va_workers WHERE id=$1 AND workspace_id=$2 FOR SHARE",[workerId,actor.workspaceId])).rows[0];
  if(!user)throw new AppError('NOT_FOUND','User not found.',404);
  if(user.role==='admin')throw new AppError('INVALID_INPUT','Administrators have unlimited requests.',422);
  const target:Actor={...actor,id:user.id,displayName:user.display_name};
  await db.query('INSERT INTO private.va_action_quotas(workspace_id,worker_id) VALUES($1,$2) ON CONFLICT(worker_id) DO NOTHING',[actor.workspaceId,workerId]);
  const row=(await db.query<QuotaRow>('SELECT generation,used,reset_at FROM private.va_action_quotas WHERE worker_id=$1 FOR UPDATE',[workerId])).rows[0];
  const actions=(await db.query(`SELECT a.session_id,EXISTS(SELECT 1 FROM public.va_attempts b WHERE b.session_id=a.session_id AND b.status IN ('reserved','writing','unknown','succeeded')) AS confirmed
    FROM private.va_actions a WHERE a.worker_id=$1 AND a.status='active' AND a.generation=$2 ORDER BY a.session_id FOR UPDATE`,[workerId,row.generation])).rows;
  for(const action of actions){
   await db.query("UPDATE private.va_actions SET status=$2,completed_at=now(),completion_reason=$3 WHERE session_id=$1",[action.session_id,action.confirmed?'completed':'reset',action.confirmed?'confirmed':'admin_reset']);
   if(!action.confirmed)await closeDraft(db,target,action.session_id,'cancelled');
  }
  const changed=(await db.query<QuotaRow>('UPDATE private.va_action_quotas SET generation=generation+1,used=0,reset_at=now() WHERE worker_id=$1 RETURNING generation,used,reset_at',[workerId])).rows[0];
  await audit(db,actor,null,'action.quota_reset',{targetWorkerId:workerId,previousUsed:row.used,closedDrafts:actions.filter(a=>!a.confirmed).length,generation:changed.generation,limit:ACTION_LIMIT});
  return summary(db,target,changed);
 });
}
