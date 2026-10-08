import 'server-only';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import { pool,transaction } from './db';
import { encrypt,decrypt,hash } from './crypto';
import { config } from './config';
import { AppError } from './errors';
import type { Actor } from './domain';
import { requireModule,auditOperation } from './workspace-modules';
import { findActor } from './auth';
import { DateTime } from 'luxon';

export const connectorInput=z.object({
 provider:z.enum(['google','outlook','icloud','fastmail']),
 clientId:z.string().trim().min(1).max(512).optional(),clientSecret:z.string().min(1).max(4096).optional(),
 calendarId:z.string().trim().min(1).max(2048).optional(),
 username:z.string().trim().min(1).max(512).optional(),password:z.string().min(1).max(4096).optional(),
 serverUrl:z.string().url().max(2048).optional(),
}).strict();
type Provider=z.infer<typeof connectorInput>['provider'];
type Calendar={id:string;label:string};
type Credentials={clientId?:string;clientSecret?:string;verifier?:string;accessToken?:string;refreshToken?:string;expiresAt?:number;username?:string;password?:string;serverUrl?:string;calendarId?:string};
const catalog=[
 {provider:'google',label:'Google Calendar',authType:'oauth',requirements:'OAuth client ID, client secret, and selected calendar ID. Register the displayed redirect URL in Google Cloud.'},
 {provider:'outlook',label:'Microsoft Outlook',authType:'oauth',requirements:'Microsoft Entra application client ID and client secret. Enable personal/organizational accounts and register the redirect URL.'},
 {provider:'icloud',label:'Apple iCloud Calendar',authType:'caldav',requirements:'Apple ID, app-specific password, and https://caldav.icloud.com. Two-factor authentication is required by Apple.'},
 {provider:'fastmail',label:'Fastmail Calendar',authType:'caldav',requirements:'Fastmail username and app password with CalDAV access. Server: https://caldav.fastmail.com.'},
] as const;
export function connectorRedirect(provider:string){return config().origin+'/api/connectors/'+provider+'/callback';}
export function safeDavUrl(value:string,provider:'icloud'|'fastmail') {
 let url:URL;try{url=new URL(value);}catch{throw new AppError('INVALID_CALDAV_URL','Enter a supported HTTPS CalDAV server URL.',422);}
 const host=url.hostname.toLowerCase();
 const allowed=provider==='icloud'?(host==='caldav.icloud.com'||/^[a-z0-9-]+\.caldav\.icloud\.com$/.test(host)||/^p[0-9]+-caldav\.icloud\.com$/.test(host)):host==='caldav.fastmail.com';
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.search||url.hash||!allowed)
  throw new AppError('INVALID_CALDAV_URL','Only the supported iCloud or Fastmail HTTPS CalDAV hosts are allowed.',422);
 return url.toString();
}
async function requestJson(url:string,init:RequestInit={}){
 let response:Response;try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new AppError('CONNECTOR_UNREACHABLE','The calendar service could not be reached. Check network access and retry.',503);}
 if(!response.ok)throw new AppError('CONNECTOR_REJECTED','The calendar provider rejected the connection. Check credentials and consent.',response.status===401||response.status===403?422:503);
 try{return JSON.parse(await boundedText(response));}catch(error){if(error instanceof AppError)throw error;throw new AppError('INVALID_CONNECTOR_RESPONSE','The calendar service returned an unreadable response.',502);}
}
async function boundedText(response:Response,limit=2*1024*1024){
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new AppError('CONNECTOR_RESPONSE_TOO_LARGE','The calendar service returned too much data. Choose a shorter range.',502);}chunks.push(value);}}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
function xmlText(xml:string,tag:string){const match=xml.match(new RegExp('<(?:[A-Za-z0-9_-]+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?'+tag+'>','i'));return match?.[1]??null;}
function unescapeXml(value:string){return value.replace(/&(?:amp|lt|gt|quot|apos);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[s]!)).trim();}
function href(xml:string,tag:string){const value=xmlText(xml,tag);const result=value&&xmlText(value,'href');return result?unescapeXml(result):null;}
export function parseDavCalendars(xml:string,base:string,provider:'icloud'|'fastmail'):Calendar[]{
 if(xml.includes('<!DOCTYPE')||xml.includes('<!ENTITY'))throw new AppError('INVALID_CALDAV_RESPONSE','Unsupported calendar server response.',502);
 const calendars:Calendar[]=[];
 for(const block of xml.match(/<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi)??[]){
  if(!/<(?:[A-Za-z0-9_-]+:)?calendar(?:\s|\/|>)/i.test(xmlText(block,'resourcetype')??''))continue;
  const path=xmlText(block,'href');if(!path)continue;
  const id=safeDavUrl(new URL(unescapeXml(path),base).toString(),provider);
  calendars.push({id,label:unescapeXml(xmlText(block,'displayname')??'Calendar')});
 }
 return calendars;
}
async function davRequest(url:string,provider:'icloud'|'fastmail',credentials:Credentials,body:string,depth:string){
 const target=safeDavUrl(url,provider);
 let response:Response;try{response=await fetch(target,{method:'PROPFIND',headers:{Authorization:'Basic '+Buffer.from(credentials.username+':'+credentials.password).toString('base64'),'Content-Type':'application/xml; charset=utf-8',Depth:depth},body,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new AppError('CONNECTOR_UNREACHABLE','The CalDAV server could not be reached. Check the server URL and network access.',503);}
 if(response.status!==207)throw new AppError('CALDAV_REJECTED','CalDAV authentication or discovery failed. Use an app-specific password.',422);
 const length=Number(response.headers.get('content-length')??0);if(length>1024*1024)throw new AppError('CALDAV_RESPONSE_TOO_LARGE','The calendar list is too large.',502);
 const xml=await boundedText(response,1024*1024);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AppError('INVALID_CALDAV_RESPONSE','Unsupported calendar server response.',502);
 return xml;
}
async function davCalendars(provider:'icloud'|'fastmail',credentials:Credentials){
 const start=safeDavUrl(credentials.serverUrl!,provider);
 const principalXml=await davRequest(start,provider,credentials,'<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>','0');
 const principal=href(principalXml,'current-user-principal');
 if(!principal)throw new AppError('CALDAV_DISCOVERY_FAILED','The server did not return a CalDAV principal.',422);
 const principalUrl=safeDavUrl(new URL(principal,start).toString(),provider);
 const homeXml=await davRequest(principalUrl,provider,credentials,'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>','0');
 const home=href(homeXml,'calendar-home-set');if(!home)throw new AppError('CALDAV_DISCOVERY_FAILED','The account has no calendar home.',422);
 const homeUrl=safeDavUrl(new URL(home,principalUrl).toString(),provider);
 const xml=await davRequest(homeUrl,provider,credentials,'<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>','1');
 const calendars=parseDavCalendars(xml,homeUrl,provider);if(!calendars.length)throw new AppError('NO_CALENDARS','This account has no accessible calendars.',422);
 return calendars;
}
export async function listConnectors(actor:Actor){
 const {rows}=await pool().query('SELECT provider,status,calendars,calendar_id,updated_at FROM private.va_external_connectors WHERE workspace_id=$1',[actor.workspaceId]);
 return catalog.map(item=>{const row=rows.find(r=>r.provider===item.provider);return {...item,connected:row?.status==='connected',calendars:row?.calendars??[],calendarId:row?.calendar_id??null,updatedAt:row?.updated_at??null,redirectUri:item.authType==='oauth'?connectorRedirect(item.provider):null};});
}
async function storeConnection(workspaceId:string,id:string,provider:Provider,credentials:Credentials,calendars:Calendar[]){
 if(credentials.calendarId&&!calendars.some(c=>c.id===credentials.calendarId))throw new AppError('CALENDAR_NOT_ACCESSIBLE','The selected calendar was not returned by the connected account.',422);
 await pool().query(`INSERT INTO private.va_external_connectors(id,workspace_id,provider,status,credentials_ciphertext,calendars,calendar_id)
 VALUES($1,$2,$3,'connected',$4,$5,$6) ON CONFLICT(workspace_id,provider) DO UPDATE SET status='connected',credentials_ciphertext=excluded.credentials_ciphertext,calendars=excluded.calendars,calendar_id=excluded.calendar_id,updated_at=now()`,
 [id,workspaceId,provider,encrypt(JSON.stringify(credentials),workspaceId+':'+provider),JSON.stringify(calendars),credentials.calendarId??calendars[0]?.id??null]);
}
export async function connectCalendar(actor:Actor,input:z.infer<typeof connectorInput>){
 const id=randomUUID();
 if(input.provider==='icloud'||input.provider==='fastmail'){
  if(!input.username||!input.password||!input.serverUrl)throw new AppError('MISSING_CREDENTIALS','Enter username, app-specific password and server URL.',422);
  const credentials:Credentials={username:input.username,password:input.password,serverUrl:safeDavUrl(input.serverUrl,input.provider),calendarId:input.calendarId};
  const calendars=await davCalendars(input.provider,credentials);await storeConnection(actor.workspaceId,id,input.provider,credentials,calendars);
  await auditOperation(actor,'connector.connected',id,{provider:input.provider,calendarCount:calendars.length});
  return {connected:true,calendars};
 }
 const clientId=input.clientId??process.env[input.provider==='google'?'GOOGLE_CLIENT_ID':'MICROSOFT_CLIENT_ID'];
 const clientSecret=input.clientSecret??process.env[input.provider==='google'?'GOOGLE_CLIENT_SECRET':'MICROSOFT_CLIENT_SECRET'];
 if(!clientId||!clientSecret)throw new AppError('MISSING_OAUTH_CONFIG','Enter the OAuth application client ID and client secret. Calendar services require OAuth consent rather than an API key.',422);
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
 const credentials:Credentials={clientId,clientSecret,verifier,calendarId:input.calendarId};
 await pool().query(`INSERT INTO private.va_connector_states(state_hash,workspace_id,connector_id,provider,credentials_ciphertext,worker_id,actor_alias,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,[hash(state),actor.workspaceId,id,input.provider,encrypt(JSON.stringify(credentials),state),actor.id,actor.displayName]);
 const params=new URLSearchParams({client_id:clientId,redirect_uri:connectorRedirect(input.provider),response_type:'code',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:input.provider==='google'?'https://www.googleapis.com/auth/calendar.readonly':'offline_access Calendars.Read'});
 if(input.provider==='google'){params.set('access_type','offline');params.set('prompt','consent');}
 return {authorizationUrl:(input.provider==='google'?'https://accounts.google.com/o/oauth2/v2/auth':'https://login.microsoftonline.com/common/oauth2/v2.0/authorize')+'?'+params};
}
export async function finishConnector(provider:'google'|'outlook',state:string,code:string){
 const claim=await transaction(async db=>{const {rows}=await db.query(`UPDATE private.va_connector_states SET consumed_at=now() WHERE state_hash=$1 AND provider=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *`,[hash(state),provider]);if(!rows[0])throw new AppError('OAUTH_STATE_EXPIRED','The connection link has expired. Start setup again.',410);return rows[0];});
 const credentials=JSON.parse(decrypt(claim.credentials_ciphertext,state)) as Credentials;
 const connectingActor={...await findActor(claim.worker_id),displayName:claim.actor_alias};await requireModule(connectingActor,'settings');
 const token=await requestJson(provider==='google'?'https://oauth2.googleapis.com/token':'https://login.microsoftonline.com/common/oauth2/v2.0/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:credentials.clientId!,client_secret:credentials.clientSecret!,code,code_verifier:credentials.verifier!,redirect_uri:connectorRedirect(provider),grant_type:'authorization_code'})});
 const tokens=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1),expires_in:z.number().positive()}).parse(token);
 credentials.accessToken=tokens.access_token;credentials.refreshToken=tokens.refresh_token;credentials.expiresAt=Date.now()+tokens.expires_in*1000;delete credentials.verifier;
 const calendars=await oauthCalendars(provider,credentials.accessToken);
 await storeConnection(claim.workspace_id,claim.connector_id,provider,credentials,calendars);
 await auditOperation(connectingActor,'connector.connected',claim.connector_id,{provider,calendarCount:calendars.length});
}
async function oauthCalendars(provider:'google'|'outlook',accessToken:string):Promise<Calendar[]>{
 const url=provider==='google'?'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250':'https://graph.microsoft.com/v1.0/me/calendars?$top=100';
 const result=await requestJson(url,{headers:{Authorization:'Bearer '+accessToken}});
 return provider==='google'?z.object({items:z.array(z.object({id:z.string(),summary:z.string().optional()}))}).parse(result).items.map(c=>({id:c.id,label:c.summary??'Calendar'})):z.object({value:z.array(z.object({id:z.string(),name:z.string()}))}).parse(result).value.map(c=>({id:c.id,label:c.name}));
}
export async function disconnectCalendar(actor:Actor,provider:Provider){
 await pool().query("UPDATE private.va_external_connectors SET status='disabled',credentials_ciphertext='',calendars='[]',calendar_id=NULL,updated_at=now() WHERE workspace_id=$1 AND provider=$2",[actor.workspaceId,provider]);
 await auditOperation(actor,'connector.disconnected',null,{provider});
 return {disconnected:true};
}
type ExternalEvent={id:string;title:string;start:string;end:string;location:string|null;provider:Provider;calendarId:string;readOnly:true};
async function activeConnection(actor:Actor,provider:Provider){
 return transaction(async db=>{
  const {rows}=await db.query("SELECT * FROM private.va_external_connectors WHERE workspace_id=$1 AND provider=$2 AND status='connected' FOR UPDATE",[actor.workspaceId,provider]);
  const row=rows[0];if(!row)throw new AppError('CONNECTOR_NOT_CONNECTED','Connect this calendar in Settings first.',409);
  const credentials=JSON.parse(decrypt(row.credentials_ciphertext,actor.workspaceId+':'+provider)) as Credentials;
  if((provider==='google'||provider==='outlook')&&(credentials.expiresAt??0)<Date.now()+60000){
   const token=await requestJson(provider==='google'?'https://oauth2.googleapis.com/token':'https://login.microsoftonline.com/common/oauth2/v2.0/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:credentials.clientId!,client_secret:credentials.clientSecret!,refresh_token:credentials.refreshToken!,grant_type:'refresh_token'})});
   const tokens=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1).optional(),expires_in:z.number().positive()}).parse(token);
   credentials.accessToken=tokens.access_token;credentials.refreshToken=tokens.refresh_token??credentials.refreshToken;credentials.expiresAt=Date.now()+tokens.expires_in*1000;
   await db.query('UPDATE private.va_external_connectors SET credentials_ciphertext=$2,updated_at=now() WHERE id=$1',[row.id,encrypt(JSON.stringify(credentials),actor.workspaceId+':'+provider)]);
  }
  return {credentials,calendarId:row.calendar_id as string,calendars:row.calendars as Calendar[]};
 });
}
function escapeXml(value:string){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));}
function davStamp(value:string){return DateTime.fromISO(value,{setZone:true}).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");}
export function parseDavEvents(xml:string,provider:'icloud'|'fastmail',calendarId:string):ExternalEvent[]{
 const events:ExternalEvent[]=[];
 for(const block of xml.match(/<(?:[A-Za-z0-9_-]+:)?calendar-data(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?calendar-data>/gi)??[]){
  const content=unescapeXml(xmlText(block,'calendar-data')??'').replace(/\r?\n[ \t]/g,'');
  for(const item of content.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)??[]){
   const property=(key:string)=>item.match(new RegExp('(?:^|\\n)'+key+'([^:\\r\\n]*):([^\\r\\n]*)'));
   const start=property('DTSTART'),end=property('DTEND');if(!start||!end)continue;
   // REPORT asks the server to expand recurrence into the requested time window.
   const parse=(match:RegExpMatchArray)=>{const zone=match[1].match(/TZID=([^;]+)/)?.[1]??'UTC';return DateTime.fromFormat(match[2],match[2].endsWith('Z')?"yyyyMMdd'T'HHmmss'Z'":match[2].length===8?'yyyyMMdd':"yyyyMMdd'T'HHmmss",{zone:match[2].endsWith('Z')?'UTC':zone}).toUTC().toISO();};
   const startsAt=parse(start),endsAt=parse(end);if(!startsAt||!endsAt)continue;
   const decode=(value:string)=>value.replace(/\\[nN]/g,'\n').replace(/\\([,;\\])/g,'$1');
   events.push({id:decode(property('UID')?.[2]??hash(item))+':'+startsAt,title:decode(property('SUMMARY')?.[2]??'Calendar event'),start:startsAt,end:endsAt,location:property('LOCATION')?decode(property('LOCATION')![2]):null,provider,calendarId,readOnly:true});
  }
 }
 return events;
}
export async function externalEvents(actor:Actor,provider:Provider,start:string,end:string,selectedCalendarId?:string){
 const a=z.string().datetime({offset:true}).parse(start),b=z.string().datetime({offset:true}).parse(end);
 if(Date.parse(b)<=Date.parse(a)||Date.parse(b)-Date.parse(a)>93*86400000)throw new AppError('INVALID_RANGE','Choose a calendar range of at most 93 days.',422);
 const {credentials,calendarId,calendars}=await activeConnection(actor,provider);const selected=selectedCalendarId??calendarId;
 if(!calendars.some(c=>c.id===selected))throw new AppError('CALENDAR_NOT_ACCESSIBLE','Choose a calendar listed by the connected account.',422);
 if(provider==='icloud'||provider==='fastmail'){
  const body='<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="'+escapeXml(davStamp(a))+'" end="'+escapeXml(davStamp(b))+'"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="'+escapeXml(davStamp(a))+'" end="'+escapeXml(davStamp(b))+'"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  let response:Response;try{response=await fetch(safeDavUrl(selected,provider),{method:'REPORT',headers:{Authorization:'Basic '+Buffer.from(credentials.username+':'+credentials.password).toString('base64'),'Content-Type':'application/xml; charset=utf-8',Depth:'1'},body,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new AppError('CONNECTOR_UNREACHABLE','The CalDAV calendar could not be reached.',503);}
  if(response.status!==207)throw new AppError('CALDAV_REJECTED','The calendar server rejected the requested date range.',502);
  const xml=await boundedText(response);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AppError('INVALID_CALDAV_RESPONSE','Unsupported calendar server response.',502);
  const all=parseDavEvents(xml,provider,selected);return {events:all.slice(0,500),truncated:all.length>500};
 }
 const params=provider==='google'?new URLSearchParams({timeMin:a,timeMax:b,singleEvents:'true',maxResults:'500',orderBy:'startTime'}):new URLSearchParams({startDateTime:a,endDateTime:b,$top:'500',$orderby:'start/dateTime'});
 const url=provider==='google'?'https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(selected)+'/events?'+params:'https://graph.microsoft.com/v1.0/me/calendars/'+encodeURIComponent(selected)+'/calendarView?'+params;
 const data=await requestJson(url,{headers:{Authorization:'Bearer '+credentials.accessToken,Prefer:'outlook.timezone="UTC"'}});
 if(provider==='google'){
  const event=z.object({id:z.string(),summary:z.string().optional(),status:z.string().optional(),location:z.string().optional(),start:z.object({dateTime:z.string().optional(),date:z.string().optional()}),end:z.object({dateTime:z.string().optional(),date:z.string().optional()})});
  const result=z.object({items:z.array(event),nextPageToken:z.string().optional()}).parse(data);
  return {events:result.items.filter(e=>e.status!=='cancelled').map(e=>({id:e.id,title:e.summary??'Calendar event',start:e.start.dateTime??e.start.date+'T00:00:00+04:00',end:e.end.dateTime??e.end.date+'T00:00:00+04:00',location:e.location??null,provider,calendarId:selected,readOnly:true as const})),truncated:!!result.nextPageToken};
 }
 const event=z.object({id:z.string(),subject:z.string(),isCancelled:z.boolean().optional(),location:z.object({displayName:z.string().optional()}).optional(),start:z.object({dateTime:z.string()}),end:z.object({dateTime:z.string()})});
 const result=z.object({value:z.array(event),'@odata.nextLink':z.string().optional()}).parse(data);
 return {events:result.value.filter(e=>!e.isCancelled).map(e=>({id:e.id,title:e.subject,start:e.start.dateTime.replace(/Z$/,'')+'Z',end:e.end.dateTime.replace(/Z$/,'')+'Z',location:e.location?.displayName??null,provider,calendarId:selected,readOnly:true as const})),truncated:!!result['@odata.nextLink']};
}
