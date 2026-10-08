import 'server-only';
import { DateTime } from 'luxon';
import type { Actor, AgendaScope, AgendaSummary, Facts, TaskDraft } from './domain';
import { actorTransaction } from './db';
import { AppError } from './errors';
import { resolveTaskDraftInTransaction } from './workspace-modules';

export async function taskDraft(actor:Actor,facts:Facts):Promise<{draft:TaskDraft|null;question:string|null}> {
 if(facts.ambiguities.length)return {draft:null,question:facts.ambiguities[0]};
 if(!facts.title?.trim())return {draft:null,question:'What needs to be done?'};
 let dueAt:string|null=null;
 if(facts.time&&!facts.date)return {draft:null,question:'Which date is the task due?'};
 if(facts.date){
  const time=facts.time??'23:59';
  const due=DateTime.fromISO(`${facts.date}T${time}`,{zone:'Asia/Dubai'});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(facts.date)||!/^\d{2}:\d{2}$/.test(time)||!due.isValid||due.toFormat('yyyy-MM-dd HH:mm')!==`${facts.date} ${time}`)
   return {draft:null,question:'What is the valid due date and time?'};
  dueAt=due.toUTC().toISO();
 }
 try {return {draft:await actorTransaction(actor,db=>resolveTaskDraftInTransaction(db,actor,{title:facts.title!,assigneeUserCode:facts.assigneeUserCode??undefined,dueAt})),question:null};}
 catch(error){if(error instanceof AppError&&error.code==='INVALID_ASSIGNEE')return {draft:null,question:'Who should take this task? Use an active user code, such as user1 or user2, or say “me”.'};throw error;}
}

export async function agenda(actor:Actor,scope:AgendaScope,now=new Date()):Promise<AgendaSummary> {
 const local=DateTime.fromJSDate(now,{zone:'Asia/Dubai'}),today=scope.startsWith('today')||scope==='today';
 const start=today?local.startOf('day'):local;
 const end=today?local.plus({days:1}).startOf('day'):local.plus({days:90});
 const includeTasks=!['appointments','today_appointments'].includes(scope);
 const includeCalendar=!['my_tasks','today_tasks'].includes(scope);
 const items=await actorTransaction(actor,async(db,member)=>{
  if(member.role!=='admin'&&((includeTasks&&member.permissions.tasks===false)||(includeCalendar&&member.permissions.calendar===false)))
   throw new AppError('FORBIDDEN','You do not have access to this agenda. Ask your administrator.',403);
  const result:AgendaSummary['items']=[];
  if(includeTasks){
   const {rows}=await db.query(`SELECT t.id,t.title,t.due_at,t.status,w.user_code FROM public.va_tasks t JOIN public.va_workers w ON w.id=t.assignee_worker_id
    WHERE t.workspace_id=$1 AND t.assignee_worker_id=$2 AND t.status<>'done'
    AND (NOT $3::boolean OR (t.due_at >= $4::timestamptz AND t.due_at < $5::timestamptz))
    AND (NOT $6::boolean OR t.due_at IS NULL OR t.due_at < $5::timestamptz)
    ORDER BY t.due_at ASC NULLS LAST,t.created_at,t.id LIMIT 51`,[actor.workspaceId,actor.id,today,start.toISO(),end.toISO(),scope==='next']);
   result.push(...rows.map(r=>({id:r.id,kind:'task' as const,title:r.title,startsAt:r.due_at?.toISOString()??null,userCode:r.user_code,status:r.status})));
  }
  if(includeCalendar){
   const {rows}=await db.query(`SELECT e.id,e.title,e.starts_at,e.ends_at,w.user_code FROM private.va_internal_events e JOIN public.va_workers w ON w.id=e.worker_id
    WHERE e.workspace_id=$1 AND e.status='confirmed' AND e.ends_at>$2::timestamptz AND e.starts_at<$3::timestamptz
    ORDER BY e.starts_at,e.id LIMIT 51`,[actor.workspaceId,start.toISO(),end.toISO()]);
   result.push(...rows.map(r=>({id:r.id,kind:'appointment' as const,title:r.title,startsAt:r.starts_at.toISOString(),endsAt:r.ends_at.toISOString(),userCode:r.user_code,status:'confirmed'})));
  }
  return result;
 });
 let externalTruncated=false;
 if(includeCalendar){
  const {listConnectors,externalEvents}=await import('./connectors');
  const connections=(await listConnectors(actor)).filter(c=>c.connected);
  const batches=await Promise.all(connections.map(async c=>({provider:c.provider,...await externalEvents(actor,c.provider,start.toUTC().toISO()!,end.toUTC().toISO()!)})));
  for(const batch of batches){externalTruncated ||= batch.truncated;items.push(...batch.events.map(e=>({id:`${batch.provider}:${e.id}`,kind:'appointment' as const,title:e.title,startsAt:e.start,endsAt:e.end,userCode:null,status:'confirmed'})));}
 }
 items.sort((a,b)=>(a.startsAt?Date.parse(a.startsAt):Infinity)-(b.startsAt?Date.parse(b.startsAt):Infinity)||a.id.localeCompare(b.id));
 const limit=scope==='next'?1:10;
 const labels:Record<AgendaScope,string>={next:'Up next',today:'Today',my_tasks:'My tasks',today_tasks:'Today’s tasks',today_appointments:'Today’s appointments',appointments:'Upcoming appointments'};
 return {scope,label:labels[scope],asOf:now.toISOString(),rangeEnd:includeCalendar&&!today?end.toISO():null,truncated:externalTruncated||items.length>limit,items:items.slice(0,limit)};
}

export function agendaReply(summary:AgendaSummary):string {
 if(!summary.items.length)return summary.scope==='next'?'Nothing scheduled in the next 90 days. You can create a task or appointment.':`No ${summary.scope.includes('task')?'tasks':summary.scope.includes('appointment')?'appointments':'items'} ${summary.scope.startsWith('today')?'scheduled today':'to show'}.`;
 if(summary.scope==='next'){
  const item=summary.items[0],time=item.startsAt?DateTime.fromISO(item.startsAt).setZone('Asia/Dubai').toFormat('d LLL, h:mm a'):'no due date';
  return `${item.kind==='task'&&item.startsAt&&Date.parse(item.startsAt)<Date.parse(summary.asOf)?'Overdue task':'Next'}: ${item.title} · ${time}.`;
 }
 const appointments=summary.items.filter(i=>i.kind==='appointment').length,tasks=summary.items.length-appointments;
 const counts=[appointments?`${appointments} appointment${appointments===1?'':'s'}`:null,tasks?`${tasks} task${tasks===1?'':'s'}`:null].filter(Boolean).join(' and ');
 return `${summary.label}: ${counts}${summary.truncated?' shown. More in the dashboard.':'.'}`;
}
