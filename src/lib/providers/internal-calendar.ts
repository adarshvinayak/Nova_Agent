import 'server-only';
import { z } from 'zod';
import { transaction,pool } from '../db';
import type { Actor,BusyInterval,CalendarProvider,CalendarEvent,EventSnapshot } from '../domain';
import { ProviderError } from '../errors';
const snapshotSchema=z.object({title:z.string().min(1).max(300),location:z.string().max(500).nullable(),start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true}),timeZone:z.literal('Asia/Dubai')});
export class InternalCalendarProvider implements CalendarProvider {
 constructor(private calendarId:string,private workspaceId:string,private actor?:Actor){}
 private check(id:string){if(id!==this.calendarId || id!==`internal:${this.workspaceId}`)throw new ProviderError('CALENDAR_MISMATCH');}
 async queryBusy(calendarId:string,start:string,end:string){this.check(calendarId);
  const local=(await pool().query<{start:string,end:string}>(`SELECT starts_at AS start,ends_at AS end FROM private.va_internal_events WHERE workspace_id=$1 AND calendar_id=$2 AND status='confirmed' AND starts_at<$4::timestamptz AND ends_at>$3::timestamptz`,[this.workspaceId,calendarId,start,end])).rows.map(e=>({start:new Date(e.start).toISOString(),end:new Date(e.end).toISOString()}));
  return [...local,...(this.actor?await connectedBusy(this.actor,start,end):[])];
 }
 async insert(calendarId:string,eventId:string,snapshot:EventSnapshot,intentHash:string):Promise<CalendarEvent>{
  this.check(calendarId);if(!/^vc[0-9a-f]{32}$/.test(eventId)||!/^[0-9a-f]{64}$/.test(intentHash)||!snapshotSchema.safeParse(snapshot).success||Date.parse(snapshot.end)<=Date.parse(snapshot.start))throw new ProviderError('CALENDAR_INVALID_SNAPSHOT');
  return transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`internal-calendar:${this.workspaceId}`]);
   const owned=(await db.query(`SELECT worker_id,intent_hash,starts_at,ends_at FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$2 AND event_id=$3 AND status IN ('writing','unknown')`,[this.workspaceId,calendarId,eventId])).rows[0];
   if(!owned || owned.intent_hash!==intentHash || new Date(owned.starts_at).getTime()!==Date.parse(snapshot.start)||new Date(owned.ends_at).getTime()!==Date.parse(snapshot.end))throw new ProviderError('CALENDAR_UNOWNED_EVENT');
   if((await db.query(`SELECT 1 FROM private.va_internal_events WHERE workspace_id=$1 AND calendar_id=$2 AND status='confirmed' AND starts_at<$4::timestamptz AND ends_at>$3::timestamptz LIMIT 1`,[this.workspaceId,calendarId,snapshot.start,snapshot.end])).rowCount)throw new ProviderError('CALENDAR_CONFLICT');
   const inserted=await db.query(`INSERT INTO private.va_internal_events(workspace_id,worker_id,calendar_id,event_id,title,location,starts_at,ends_at,time_zone,intent_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(calendar_id,event_id) DO NOTHING`,[this.workspaceId,owned.worker_id,calendarId,eventId,snapshot.title,snapshot.location,snapshot.start,snapshot.end,snapshot.timeZone,intentHash]);
   if(!inserted.rowCount)throw new ProviderError('CALENDAR_EVENT_EXISTS',true);
   return {...snapshot,id:eventId,intentHash,status:'confirmed' as const};
  });
 }
 async readCreated(calendarId:string,eventId:string):Promise<CalendarEvent|null>{this.check(calendarId);
  const owned=await pool().query('SELECT id FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$2 AND event_id=$3',[this.workspaceId,calendarId,eventId]);
  if(!owned.rowCount)throw new ProviderError('CALENDAR_UNOWNED_EVENT');
  const row=(await pool().query(`SELECT * FROM private.va_internal_events WHERE workspace_id=$1 AND calendar_id=$2 AND event_id=$3`,[this.workspaceId,calendarId,eventId])).rows[0];
  return row?{id:row.event_id,title:row.title,location:row.location,start:new Date(row.starts_at).toISOString(),end:new Date(row.ends_at).toISOString(),timeZone:row.time_zone,intentHash:row.intent_hash,status:row.status}:null;
 }
}

export async function connectedBusy(actor:Actor,start:string,end:string):Promise<BusyInterval[]>{
 const {listConnectors,externalEvents}=await import('../connectors');
 const connections=(await listConnectors(actor)).filter(c=>c.connected);
 const batches=await Promise.all(connections.map(async c=>{
  const result=await externalEvents(actor,c.provider,start,end);
  if(result.truncated)throw new ProviderError('CALENDAR_AVAILABILITY_UNKNOWN');
  return result.events.map(e=>{
   if(!Number.isFinite(Date.parse(e.start))||!Number.isFinite(Date.parse(e.end))||Date.parse(e.end)<=Date.parse(e.start))throw new ProviderError('CALENDAR_AVAILABILITY_UNKNOWN');
   return {start:e.start,end:e.end};
  });
 }));
 return batches.flat();
}
