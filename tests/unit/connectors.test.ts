import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
const db=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../../src/lib/db',()=>({pool:()=>db,transaction:async(work:(client:{query:ReturnType<typeof vi.fn>})=>unknown)=>work(db)}));
vi.mock('../../src/lib/workspace-modules',()=>({requireModule:vi.fn(),auditOperation:vi.fn()}));
import { connectCalendar,safeDavUrl,parseDavCalendars,parseDavEvents,externalEvents } from '../../src/lib/connectors';
import { encrypt } from '../../src/lib/crypto';
import type { Actor } from '../../src/lib/domain';
const actor={id:'20000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000001',email:'user1@local',displayName:'Test'} as Actor;
beforeEach(()=>{vi.stubEnv('APP_ORIGIN','http://localhost:3000');vi.stubEnv('TOKEN_ENCRYPTION_KEY','1'.repeat(64));db.query.mockReset();db.query.mockResolvedValue({rows:[],rowCount:1});});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('external calendar connectors',()=>{
 it('allows known CalDAV hosts and blocks SSRF targets, credentials, ports and host suffix tricks',()=>{
  expect(safeDavUrl('https://p123-caldav.caldav.icloud.com/123/calendar/','icloud')).toContain('icloud.com');
  expect(safeDavUrl('https://p123-caldav.icloud.com/123/calendar/','icloud')).toContain('icloud.com');
  expect(safeDavUrl('https://caldav.fastmail.com/dav/','fastmail')).toContain('fastmail.com');
  for(const url of ['http://caldav.icloud.com','https://127.0.0.1','https://169.254.169.254','https://caldav.icloud.com.attacker.test','https://user:password@caldav.icloud.com','https://caldav.icloud.com:444','https://caldav.icloud.com?redirect=1'])expect(()=>safeDavUrl(url,'icloud')).toThrow();
 });
 it('accepts namespaced calendar lists and rejects arbitrary credential destinations in responses',()=>{
  const xml='<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/123/cal/</D:href><D:propstat><D:prop><D:displayname>Work &amp; travel</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>';
  expect(parseDavCalendars(xml,'https://caldav.icloud.com/','icloud')).toEqual([{id:'https://caldav.icloud.com/123/cal/',label:'Work & travel'}]);
  expect(()=>parseDavCalendars(xml.replace('/123/cal/','https://attacker.test/cal/'),'https://caldav.icloud.com/','icloud')).toThrow();
  expect(()=>parseDavCalendars('<!DOCTYPE html>'+xml,'https://caldav.icloud.com/','icloud')).toThrow();
 });
 it('parses expanded ICS events with Dubai timestamps, UTC and escaped titles',()=>{
  const ics='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:appointment1\nDTSTART;TZID=Asia/Dubai:20261010T100000\nDTEND;TZID=Asia/Dubai:20261010T103000\nSUMMARY:Meet\\, discuss\nLOCATION:Office\nEND:VEVENT\nEND:VCALENDAR';
  const result=parseDavEvents('<c:calendar-data>'+ics+'</c:calendar-data>','icloud','https://caldav.icloud.com/cal/');
  expect(result[0]).toMatchObject({title:'Meet, discuss',start:'2026-10-10T06:00:00.000Z',end:'2026-10-10T06:30:00.000Z',readOnly:true});
 });
 it('starts OAuth with bounded state, PKCE and read-only access, storing only encrypted client credentials',async()=>{
  const result=await connectCalendar(actor,{provider:'outlook',clientId:'test-client',clientSecret:'synthetic-secret'});
  const url=new URL(result.authorizationUrl!);expect(url.origin).toBe('https://login.microsoftonline.com');expect(url.searchParams.get('scope')).toBe('offline_access Calendars.Read');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const values=db.query.mock.calls[0][1];expect(values.join(' ')).not.toContain('synthetic-secret');expect(values[0]).not.toBe(url.searchParams.get('state'));
 });
 it('requires OAuth app credentials instead of claiming arbitrary API keys will work',async()=>{
  vi.stubEnv('GOOGLE_CLIENT_ID','');vi.stubEnv('GOOGLE_CLIENT_SECRET','');await expect(connectCalendar(actor,{provider:'google'})).rejects.toMatchObject({code:'MISSING_OAUTH_CONFIG'});
 });
 it('imports Google events only from accessible calendars and reports pagination',async()=>{
  const credentials={accessToken:'synthetic-access',expiresAt:Date.now()+3600000};
  db.query.mockResolvedValue({rows:[{id:'connection',calendar_id:'work',calendars:[{id:'work',label:'Work'}],credentials_ciphertext:encrypt(JSON.stringify(credentials),actor.workspaceId+':google')}],rowCount:1});
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[{id:'e1',summary:'Meeting',start:{dateTime:'2026-10-10T10:00:00+04:00'},end:{dateTime:'2026-10-10T10:30:00+04:00'}}],nextPageToken:'next'}),{status:200}));vi.stubGlobal('fetch',fetchMock);
  const result=await externalEvents(actor,'google','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');expect(result.events[0]).toMatchObject({title:'Meeting',readOnly:true});expect(result.truncated).toBe(true);
  await expect(externalEvents(actor,'google','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z','foreign')).rejects.toMatchObject({code:'CALENDAR_NOT_ACCESSIBLE'});expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('rejects unbounded or inverted import ranges before provider access',async()=>{
  await expect(externalEvents(actor,'google','2026-10-01T00:00:00Z','2027-10-01T00:00:00Z')).rejects.toMatchObject({code:'INVALID_RANGE'});expect(db.query).not.toHaveBeenCalled();
 });
});
