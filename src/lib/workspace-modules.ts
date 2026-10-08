import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { actorTransaction } from './db';
import { actionQuota,refreshActionQuota } from './action-quota';
import { AppError } from './errors';
export type ModuleName='tasks'|'calendar'|'audit'|'settings'|'capture';
export async function moduleTransaction<T>(actor:Actor,module:ModuleName,work:(db:PoolClient)=>Promise<T>){
 return actorTransaction(actor,async (db,member)=>{
  if(member.role!=='admin' && member.permissions[module]===false)throw new AppError('FORBIDDEN','You do not have access to this section.',403);
  return work(db);
 });
}
export async function tasks(actor:Actor,assigned=false){return moduleTransaction(actor,'tasks',async db=>({
 tasks:(await db.query(`SELECT t.id,t.title,t.status,t.worker_id AS "workerId",w.user_code AS "userCode",w.user_code AS "creatorUserCode",a.user_code AS "assigneeUserCode",t.assignee_worker_id AS "assigneeWorkerId",t.due_at AS "dueAt",t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM public.va_tasks t JOIN public.va_workers w ON w.id=t.worker_id JOIN public.va_workers a ON a.id=t.assignee_worker_id WHERE t.workspace_id=$1 AND (NOT $3::boolean OR t.worker_id=$2 OR t.assignee_worker_id=$2 OR EXISTS(SELECT 1 FROM public.va_workers WHERE id=$2 AND role='admin')) ORDER BY (t.status='done'),t.due_at ASC NULLS LAST,t.created_at ASC,t.id LIMIT 200`,[actor.workspaceId,actor.id,assigned])).rows,
 users:(await db.query(`SELECT id,user_code AS "userCode" FROM public.va_workers WHERE workspace_id=$1 AND active AND user_code IS NOT NULL AND (role='admin' OR coalesce((permissions->>'tasks')::boolean,true)) ORDER BY user_code`,[actor.workspaceId])).rows
}));}
const taskInput=z.object({id:z.string().uuid().optional(),title:z.string().trim().min(1).max(300),status:z.enum(['open','todo','in_progress','done']).default('todo').transform(value=>value==='open'?'todo':value),assigneeUserCode:z.string().trim().min(1).max(32).optional(),dueAt:z.string().datetime({offset:true}).nullable().optional()});
export type TaskCreation={title:string;assigneeUserCode?:string;dueAt?:string|null;sourceSessionId?:string};
async function taskAssignee(db:PoolClient,actor:Actor,userCode?:string){
 const member=(await db.query('SELECT role,permissions FROM public.va_workers WHERE id=$1 AND workspace_id=$2 AND active FOR SHARE',[actor.id,actor.workspaceId])).rows[0];
 if(!member)throw new AppError('UNAUTHORIZED','Please sign in again.',401);
 if(member.role!=='admin'&&member.permissions.tasks===false)throw new AppError('FORBIDDEN','You do not have access to tasks.',403);
 const target=(await db.query(`SELECT id,user_code FROM public.va_workers WHERE workspace_id=$1 AND active AND (($2::text IS NULL AND id=$3) OR user_code=$2) AND (role='admin' OR coalesce((permissions->>'tasks')::boolean,true)) FOR SHARE`,[actor.workspaceId,userCode??null,actor.id])).rows[0];
 if(!target)throw new AppError('INVALID_ASSIGNEE','Choose an active user with task access.',422);
 return target;
}
/** Resolve an active stable user code before offering a task confirmation. */
export async function resolveTaskDraftInTransaction(db:PoolClient,actor:Actor,input:TaskCreation){
 const data=taskInput.parse(input);const target=await taskAssignee(db,actor,data.assigneeUserCode);
 return {title:data.title,assigneeUserCode:target.user_code as string,dueAt:data.dueAt??null};
}
/** Called inside the existing actor transaction; a source session can create only one task. */
export async function createTaskInTransaction(db:PoolClient,actor:Actor,input:TaskCreation){
 const data=taskInput.parse(input);const source=input.sourceSessionId?z.uuid().parse(input.sourceSessionId):null;
 const target=await taskAssignee(db,actor,data.assigneeUserCode);
 if(source){const session=await db.query('SELECT id FROM public.va_sessions WHERE id=$1 AND workspace_id=$2 AND worker_id=$3 FOR UPDATE',[source,actor.workspaceId,actor.id]);if(!session.rowCount)throw new AppError('NOT_FOUND','Conversation not found.',404);}
 const result=await db.query(`INSERT INTO public.va_tasks(workspace_id,worker_id,title,status,assignee_worker_id,due_at,source_session_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_session_id) WHERE source_session_id IS NOT NULL DO NOTHING RETURNING id`,[actor.workspaceId,actor.id,data.title,data.status,target.id,data.dueAt??null,source]);
 const id=result.rows[0]?.id??(source?(await db.query('SELECT id FROM public.va_tasks WHERE source_session_id=$1 AND workspace_id=$2 AND worker_id=$3',[source,actor.workspaceId,actor.id])).rows[0]?.id:null);
 if(!id)throw new AppError('CONFLICT','Task creation could not be completed.',409);
 return {id,assigneeUserCode:target.user_code};
}
export async function saveTask(actor:Actor,input:unknown){const data=taskInput.parse(input);await assertDashboardWritable(actor);return moduleTransaction(actor,'tasks',async db=>{
 await assertDashboardWritableInTransaction(db,actor);
 if(!data.id)return createTaskInTransaction(db,actor,data);
 const target=data.assigneeUserCode?await taskAssignee(db,actor,data.assigneeUserCode):null;
 const result=await db.query(`UPDATE public.va_tasks SET title=$3,status=$4,assignee_worker_id=coalesce($5,assignee_worker_id),due_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE due_at END,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id`,[data.id,actor.workspaceId,data.title,data.status,target?.id??null,data.dueAt!==undefined,data.dueAt??null]);
 if(!result.rowCount)throw new AppError('NOT_FOUND','Task not found.',404);return {id:result.rows[0].id};
});}
const timestamp=z.string().datetime({offset:true});
const eventInput=z.object({title:z.string().trim().min(1).max(300),start:timestamp,end:timestamp,location:z.string().trim().max(500).nullable().optional()}).refine(x=>Date.parse(x.end)>Date.parse(x.start),'End must follow start');
export async function events(actor:Actor,start?:string,end?:string){const range=start&&end?{start:timestamp.parse(start),end:timestamp.parse(end)}:null;return moduleTransaction(actor,'calendar',async db=>({events:(await db.query(`SELECT e.id,e.event_id AS "eventId",e.title,e.location,e.starts_at AS "start",e.ends_at AS "end",e.time_zone AS "timeZone",w.user_code AS "userCode",e.worker_id AS "workerId",e.status FROM private.va_internal_events e JOIN public.va_workers w ON w.id=e.worker_id WHERE e.workspace_id=$1 AND e.status='confirmed' AND ($2::timestamptz IS NULL OR e.ends_at>$2) AND ($3::timestamptz IS NULL OR e.starts_at<$3) ORDER BY e.starts_at LIMIT 500`,[actor.workspaceId,range?.start??null,range?.end??null])).rows}));}
export async function saveEvent(actor:Actor,input:unknown){const data=eventInput.parse(input);await assertDashboardWritable(actor);await requireModule(actor,'calendar');const {connectedBusy}=await import('./providers/internal-calendar');const external=await connectedBusy(actor,data.start,data.end);if(external.some(e=>Date.parse(e.start)<Date.parse(data.end)&&Date.parse(e.end)>Date.parse(data.start)))throw new AppError('CONFLICT','This time overlaps a connected calendar appointment. Choose another time.',409);return moduleTransaction(actor,'calendar',async db=>{
 await assertDashboardWritableInTransaction(db,actor);
 // Serialize manual creation with internal provider insertion for the same workspace.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`internal-calendar:${actor.workspaceId}`]);
 const busy=await db.query(`SELECT 1 FROM private.va_internal_events WHERE workspace_id=$1 AND status='confirmed' AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz UNION ALL SELECT 1 FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$4 AND status IN ('reserved','writing','unknown','succeeded') AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz LIMIT 1`,[actor.workspaceId,data.start,data.end,`internal:${actor.workspaceId}`]);
 if(busy.rowCount)throw new AppError('CONFLICT','This time overlaps an appointment. Choose another time.',409);
 const {rows}=await db.query(`INSERT INTO private.va_internal_events(workspace_id,worker_id,calendar_id,event_id,title,location,starts_at,ends_at) VALUES($1,$2,$3,'manual-'||gen_random_uuid(),$4,$5,$6,$7) RETURNING id`,[actor.workspaceId,actor.id,`internal:${actor.workspaceId}`,data.title,data.location??null,data.start,data.end]);return {id:rows[0].id};
 });}
const auditCursor=z.object({at:z.string().datetime(),id:z.string().uuid()});
export async function audit(actor:Actor,cursor?:string){
 let after:z.infer<typeof auditCursor>|null=null;
 if(cursor){try{if(cursor.length>512)throw new Error();after=auditCursor.parse(JSON.parse(Buffer.from(cursor,'base64url').toString()));}catch{throw new AppError('INVALID_INPUT','The audit page cursor is invalid.',422);}}
 return moduleTransaction(actor,'audit',async db=>{
 const admin=(await db.query('SELECT role FROM public.va_workers WHERE id=$1',[actor.id])).rows[0].role==='admin';
 const {rows}=await db.query(`SELECT o.id,o.event_type AS "eventType",o.subject_id AS "subjectId",o.session_id AS "sessionId",o.created_at AS "createdAt",o.detail,o.content,o.content_redacted_at AS "contentRedactedAt",coalesce(o.detail->>'userCode',w.user_code,'worker') AS "userCode",coalesce(o.detail->>'alias',w.display_name) AS alias FROM private.va_operation_events o LEFT JOIN public.va_workers w ON w.id=o.actor_worker_id WHERE o.workspace_id=$1 AND ($3::boolean OR o.actor_worker_id=$2) AND ($4::timestamptz IS NULL OR (o.created_at,o.id)<($4::timestamptz,$5::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT 51`,[actor.workspaceId,actor.id,admin,after?.at??null,after?.id??null]);
 const logs=rows.slice(0,50),last=logs.at(-1);
 return {logs,nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify({at:last.createdAt.toISOString(),id:last.id})).toString('base64url'):null};
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
 const target=(await db.query('SELECT id,role,permissions,active FROM public.va_workers WHERE workspace_id=$1 AND user_code=$2 FOR UPDATE',[actor.workspaceId,data.userCode])).rows[0];
 if(!target)throw new AppError('NOT_FOUND','User not found.',404);
 if(target.role==='admin')throw new AppError('INVALID_INPUT','Administrator access cannot be disabled here.',422);
 await db.query('UPDATE public.va_workers SET permissions=$2,active=coalesce($3,active) WHERE id=$1',[target.id,data.permissions,data.active??null]);
 await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail,content) VALUES($1,$2,$3,'permissions.updated',jsonb_build_object('userCode',(SELECT user_code FROM va_workers WHERE id=$2),'alias',$4::text,'targetUserCode',$5::text,'permissions',$6::jsonb),jsonb_build_object('before',$7::jsonb,'after',$8::jsonb))`,[actor.workspaceId,actor.id,target.id,actor.displayName,data.userCode,JSON.stringify(data.permissions),JSON.stringify({permissions:target.permissions,active:target.active}),JSON.stringify({permissions:data.permissions,active:data.active??target.active})]);
 return {saved:true};
 });}
/** Keep arbitrary provider responses out of audits; callers supply bounded safe facts. */
export async function auditOperation(actor:Actor,eventType:string,subjectId:string|null=null,detail:Record<string,unknown>={},content:Record<string,unknown>={}){
 const safe=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.slice(0,100).map(safe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/secret|password|token|credential|authorization|audio|ciphertext|hash/i.test(key)).map(([key,v])=>[key,safe(v)]));
  return typeof value==='string'?value.slice(0,8000):value;
 };
 return actorTransaction(actor,async db=>{
  await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail,session_id,content) VALUES($1,$2,$3,$4,$5::jsonb||jsonb_build_object('userCode',(SELECT user_code FROM public.va_workers WHERE id=$2)),$6,$7)`,[actor.workspaceId,actor.id,subjectId,eventType,{...safe(detail) as Record<string,unknown>,alias:actor.displayName},typeof detail.sessionId==='string'?z.uuid().parse(detail.sessionId):null,safe(content)]);
 });
}
export async function requireModule(actor:Actor,module:ModuleName){return moduleTransaction(actor,module,async()=>undefined);}

export async function assertDashboardWritableInTransaction(db:PoolClient,actor:Actor){
 const quota=await actionQuota(db,actor);
 if(quota.exhausted)throw new AppError('ACTION_LIMIT_REACHED','Request limit reached. Contact your admin.',429);
}
export async function assertDashboardWritable(actor:Actor){
 const quota=await refreshActionQuota(actor);
 if(quota.exhausted)throw new AppError('ACTION_LIMIT_REACHED','Request limit reached. Contact your admin.',429);
}
