import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { actorTransaction } from './db';
import { AppError } from './errors';
export type ModuleName='tasks'|'calendar'|'audit'|'settings'|'capture';
export async function moduleTransaction<T>(actor:Actor,module:ModuleName,work:(db:PoolClient)=>Promise<T>){
 return actorTransaction(actor,async db=>{
  const {rows}=await db.query('SELECT role,permissions FROM public.va_workers WHERE id=$1 AND workspace_id=$2',[actor.id,actor.workspaceId]);
  if(rows[0].role!=='admin' && rows[0].permissions[module]===false)throw new AppError('FORBIDDEN','You do not have access to this section.',403);
  await db.query("SELECT set_config('nova.actor_id',$1,true),set_config('nova.actor_alias',$2,true)",[actor.id,actor.displayName]);
  return work(db);
 });
}
export async function tasks(actor:Actor){return moduleTransaction(actor,'tasks',async db=>({tasks:(await db.query(`SELECT t.id,t.title,t.status,t.worker_id AS "workerId",w.user_code AS "userCode",t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM public.va_tasks t JOIN public.va_workers w ON w.id=t.worker_id WHERE t.workspace_id=$1 ORDER BY t.created_at DESC LIMIT 200`,[actor.workspaceId])).rows}));}
const taskInput=z.object({id:z.string().uuid().optional(),title:z.string().trim().min(1).max(300),status:z.enum(['open','todo','in_progress','done']).default('todo').transform(value=>value==='open'?'todo':value)});
export async function saveTask(actor:Actor,input:unknown){const data=taskInput.parse(input);return moduleTransaction(actor,'tasks',async db=>{
 const result=data.id?await db.query('UPDATE public.va_tasks SET title=$3,status=$4,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id',[data.id,actor.workspaceId,data.title,data.status]):await db.query('INSERT INTO public.va_tasks(workspace_id,worker_id,title,status) VALUES($1,$2,$3,$4) RETURNING id',[actor.workspaceId,actor.id,data.title,data.status]);
 if(!result.rowCount)throw new AppError('NOT_FOUND','Task not found.',404);return {id:result.rows[0].id};
});}
const timestamp=z.string().datetime({offset:true});
const eventInput=z.object({title:z.string().trim().min(1).max(300),start:timestamp,end:timestamp,location:z.string().trim().max(500).nullable().optional()}).refine(x=>Date.parse(x.end)>Date.parse(x.start),'End must follow start');
export async function events(actor:Actor,start?:string,end?:string){const range=start&&end?{start:timestamp.parse(start),end:timestamp.parse(end)}:null;return moduleTransaction(actor,'calendar',async db=>({events:(await db.query(`SELECT e.id,e.event_id AS "eventId",e.title,e.location,e.starts_at AS "start",e.ends_at AS "end",e.time_zone AS "timeZone",w.user_code AS "userCode",e.worker_id AS "workerId",e.status FROM private.va_internal_events e JOIN public.va_workers w ON w.id=e.worker_id WHERE e.workspace_id=$1 AND e.status='confirmed' AND ($2::timestamptz IS NULL OR e.ends_at>$2) AND ($3::timestamptz IS NULL OR e.starts_at<$3) ORDER BY e.starts_at LIMIT 500`,[actor.workspaceId,range?.start??null,range?.end??null])).rows}));}
export async function saveEvent(actor:Actor,input:unknown){const data=eventInput.parse(input);await requireModule(actor,'calendar');const {connectedBusy}=await import('./providers/internal-calendar');const external=await connectedBusy(actor,data.start,data.end);if(external.some(e=>Date.parse(e.start)<Date.parse(data.end)&&Date.parse(e.end)>Date.parse(data.start)))throw new AppError('CONFLICT','This time overlaps a connected calendar appointment. Choose another time.',409);return moduleTransaction(actor,'calendar',async db=>{
 // Serialize manual creation with internal provider insertion for the same workspace.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`internal-calendar:${actor.workspaceId}`]);
 const busy=await db.query(`SELECT 1 FROM private.va_internal_events WHERE workspace_id=$1 AND status='confirmed' AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz UNION ALL SELECT 1 FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$4 AND status IN ('reserved','writing','unknown','succeeded') AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz LIMIT 1`,[actor.workspaceId,data.start,data.end,`internal:${actor.workspaceId}`]);
 if(busy.rowCount)throw new AppError('CONFLICT','This time overlaps an appointment. Choose another time.',409);
 const {rows}=await db.query(`INSERT INTO private.va_internal_events(workspace_id,worker_id,calendar_id,event_id,title,location,starts_at,ends_at) VALUES($1,$2,$3,'manual-'||gen_random_uuid(),$4,$5,$6,$7) RETURNING id`,[actor.workspaceId,actor.id,`internal:${actor.workspaceId}`,data.title,data.location??null,data.start,data.end]);return {id:rows[0].id};
 });}
export async function audit(actor:Actor){return moduleTransaction(actor,'audit',async db=>{
 const admin=(await db.query('SELECT role FROM public.va_workers WHERE id=$1',[actor.id])).rows[0].role==='admin';
 return {logs:(await db.query(`SELECT o.id,o.event_type AS "eventType",o.subject_id AS "subjectId",o.created_at AS "createdAt",o.detail,coalesce(o.detail->>'userCode',w.user_code,'worker') AS "userCode",coalesce(o.detail->>'alias',w.display_name) AS alias FROM private.va_operation_events o LEFT JOIN public.va_workers w ON w.id=o.actor_worker_id WHERE o.workspace_id=$1 AND ($3::boolean OR o.actor_worker_id=$2) ORDER BY o.created_at DESC,o.id DESC LIMIT 200`,[actor.workspaceId,actor.id,admin])).rows};
 });}
export async function settings(actor:Actor){return moduleTransaction(actor,'settings',async db=>{
 const {rows:users}=await db.query(`SELECT id,user_code AS "userCode",display_name AS "displayName",role,active,permissions FROM public.va_workers WHERE workspace_id=$1 ORDER BY user_code`,[actor.workspaceId]);
 const {rows:connectors}=await db.query(`SELECT provider,status,calendars,calendar_id AS "calendarId",(status='connected' AND length(credentials_ciphertext)>0) AS "hasCredentials",updated_at AS "updatedAt" FROM private.va_external_connectors WHERE workspace_id=$1`,[actor.workspaceId]);
 return {users,connectors};
 });}
const permissionsInput=z.object({action:z.literal('permissions'),userCode:z.string().min(1).max(32),permissions:z.object({capture:z.boolean(),tasks:z.boolean(),calendar:z.boolean(),audit:z.boolean(),settings:z.boolean()}),active:z.boolean().optional()});
export async function savePermissions(actor:Actor,input:unknown){const data=permissionsInput.parse(input);return moduleTransaction(actor,'settings',async db=>{
 const role=(await db.query('SELECT role FROM public.va_workers WHERE id=$1',[actor.id])).rows[0].role;
 if(role!=='admin')throw new AppError('FORBIDDEN','Administrator access is required.',403);
 const target=(await db.query('SELECT id,role FROM public.va_workers WHERE workspace_id=$1 AND user_code=$2 FOR UPDATE',[actor.workspaceId,data.userCode])).rows[0];
 if(!target)throw new AppError('NOT_FOUND','User not found.',404);
 if(target.role==='admin')throw new AppError('INVALID_INPUT','Administrator access cannot be disabled here.',422);
 await db.query('UPDATE public.va_workers SET permissions=$2,active=coalesce($3,active) WHERE id=$1',[target.id,data.permissions,data.active??null]);
 await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail) VALUES($1,$2,$3,'permissions.updated',jsonb_build_object('userCode',(SELECT user_code FROM va_workers WHERE id=$2),'alias',$4::text,'targetUserCode',$5::text,'permissions',$6::jsonb))`,[actor.workspaceId,actor.id,target.id,actor.displayName,data.userCode,JSON.stringify(data.permissions)]);
 return {saved:true};
 });}
export async function auditOperation(actor:Actor,eventType:string,subjectId:string|null=null,detail:Record<string,unknown>={}){
 return actorTransaction(actor,async db=>{
  await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail) VALUES($1,$2,$3,$4,$5)`,[actor.workspaceId,actor.id,subjectId,eventType,{...detail,userCode:(await db.query('SELECT user_code FROM public.va_workers WHERE id=$1',[actor.id])).rows[0].user_code,alias:actor.displayName}]);
 });
}
export async function requireModule(actor:Actor,module:ModuleName){return moduleTransaction(actor,module,async()=>undefined);}
