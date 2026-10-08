import 'server-only';
import { InternalCalendarProvider } from './internal-calendar';
import { z } from 'zod';
import { config, requiredSecret } from '../config';
import { decrypt, encrypt } from '../crypto';
import { pool } from '../db';
import type { Actor, CalendarEvent, CalendarProvider, EventSnapshot } from '../domain';
import { ProviderError } from '../errors';
import { providerJson, providerRequest } from './http';

type Connection = { id: string; calendar_id: string; workspace_id: string; status: string; provider: string;
  access_token_ciphertext: string | null; refresh_token_ciphertext: string | null; access_expires_at: Date | string | null };
const appEventId = /^vc[0-9a-f]{32}$/;
const intentHashPattern = /^[0-9a-f]{64}$/;
const dateTime = z.string().refine(s => /(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)));
const snapshotSchema = z.object({ title: z.string().min(1).max(300), location: z.string().max(500).nullable(),
  start: dateTime, end: dateTime, timeZone: z.string().min(1).max(100) });

export function sameSnapshot(a: EventSnapshot, b: EventSnapshot) {
  return a.title === b.title && (a.location ?? null) === (b.location ?? null) && Date.parse(a.start) === Date.parse(b.start)
    && Date.parse(a.end) === Date.parse(b.end) && a.timeZone === b.timeZone;
}

function validateId(id: string) { if (!appEventId.test(id)) throw new ProviderError('CALENDAR_INVALID_APP_EVENT_ID'); }
function validateSnapshot(snapshot: EventSnapshot) {
  if (!snapshotSchema.safeParse(snapshot).success || Date.parse(snapshot.end) <= Date.parse(snapshot.start)) throw new ProviderError('CALENDAR_INVALID_SNAPSHOT');
}

export function parseGoogleEvent(value: unknown, id: string, ambiguous: boolean): CalendarEvent {
  const parsed = z.object({ id: z.literal(id), status: z.enum(['confirmed', 'cancelled']), summary: z.string().min(1),
    location: z.string().optional(), start: z.object({ dateTime, timeZone: z.string() }),
    end: z.object({ dateTime, timeZone: z.string() }),
    extendedProperties: z.object({ private: z.object({ intentHash: z.string().regex(intentHashPattern) }) }),
  }).safeParse(value);
  if (!parsed.success || parsed.data.start.timeZone !== parsed.data.end.timeZone) throw new ProviderError('CALENDAR_UNVERIFIED_EVENT', ambiguous);
  const event: CalendarEvent = { id, title: parsed.data.summary, location: parsed.data.location ?? null,
    start: parsed.data.start.dateTime, end: parsed.data.end.dateTime, timeZone: parsed.data.start.timeZone,
    status: parsed.data.status, intentHash: parsed.data.extendedProperties.private.intentHash };
  if (Date.parse(event.end) <= Date.parse(event.start)) throw new ProviderError('CALENDAR_UNVERIFIED_EVENT', ambiguous);
  return event;
}

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(private connection: Connection) {}

  private checkCalendar(calendarId: string) {
    if (calendarId !== this.connection.calendar_id) throw new ProviderError('CALENDAR_MISMATCH');
  }

  private async token(forceRefresh = false): Promise<string> {
    const current = await pool().query<Connection>('SELECT * FROM private.va_calendar_connections WHERE id=$1 AND workspace_id=$2', [this.connection.id, this.connection.workspace_id]);
    const conn = current.rows[0];
    if (!conn || conn.status !== 'connected' || conn.provider !== 'google' || conn.calendar_id !== this.connection.calendar_id) throw new ProviderError('CALENDAR_RECONNECT_REQUIRED');
    this.connection = conn;
    if (!forceRefresh && conn.access_token_ciphertext && conn.access_expires_at && new Date(conn.access_expires_at).getTime() > Date.now() + 30_000) {
      return decrypt(conn.access_token_ciphertext, conn.id);
    }
    if (!conn.refresh_token_ciphertext) throw new ProviderError('CALENDAR_RECONNECT_REQUIRED');
    const response = await providerRequest('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(conn.refresh_token_ciphertext, conn.id),
        client_id: requiredSecret('GOOGLE_CLIENT_ID'), client_secret: requiredSecret('GOOGLE_CLIENT_SECRET') }),
    });
    const body = await providerJson(response);
    if (!response.ok) {
      if (z.object({ error: z.literal('invalid_grant') }).safeParse(body).success) {
        await pool().query("UPDATE private.va_calendar_connections SET status='reconnect_required' WHERE id=$1 AND refresh_token_ciphertext=$2", [conn.id, conn.refresh_token_ciphertext]);
        throw new ProviderError('CALENDAR_RECONNECT_REQUIRED');
      }
      throw new ProviderError('CALENDAR_REFRESH_UNAVAILABLE');
    }
    const tokens = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), refresh_token: z.string().min(1).optional() }).safeParse(body);
    if (!tokens.success) throw new ProviderError('CALENDAR_INVALID_TOKEN_RESPONSE');
    const refresh = tokens.data.refresh_token ? encrypt(tokens.data.refresh_token, conn.id) : conn.refresh_token_ciphertext;
    const updated = await pool().query(`UPDATE private.va_calendar_connections SET access_token_ciphertext=$2,
      refresh_token_ciphertext=$3,access_expires_at=$4 WHERE id=$1 AND status='connected' AND refresh_token_ciphertext=$5`,
    [conn.id, encrypt(tokens.data.access_token, conn.id), refresh, new Date(Date.now() + tokens.data.expires_in * 1000), conn.refresh_token_ciphertext]);
    if (!updated.rowCount) throw new ProviderError('CALENDAR_CONNECTION_CHANGED');
    return tokens.data.access_token;
  }

  private async request(path: string, init: RequestInit, write = false) {
    let response = await providerRequest(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
    }, write);
    if (response.status === 401) {
      response = await providerRequest(`https://www.googleapis.com/calendar/v3${path}`, {
        ...init, headers: { ...init.headers, Authorization: `Bearer ${await this.token(true)}`, 'Content-Type': 'application/json' },
      }, write);
    }
    return response;
  }

  async queryBusy(calendarId: string, start: string, end: string) {
    this.checkCalendar(calendarId);
    const response = await this.request('/freeBusy', { method: 'POST', body: JSON.stringify({ timeMin: start, timeMax: end, items: [{ id: calendarId }] }) });
    if (!response.ok) throw new ProviderError('CALENDAR_AVAILABILITY_UNAVAILABLE');
    const data = z.object({ calendars: z.record(z.string(), z.object({ errors: z.array(z.unknown()).optional(),
      busy: z.array(z.object({ start: dateTime, end: dateTime })).optional() })) }).safeParse(await providerJson(response));
    const calendar = data.success ? data.data.calendars[calendarId] : undefined;
    if (!calendar || calendar.errors?.length || !calendar.busy || calendar.busy.some(b => Date.parse(b.end) <= Date.parse(b.start))) throw new ProviderError('CALENDAR_AVAILABILITY_UNKNOWN');
    return calendar.busy;
  }

  async insert(calendarId: string, eventId: string, snapshot: EventSnapshot, intentHash: string) {
    this.checkCalendar(calendarId); validateId(eventId); validateSnapshot(snapshot);
    if (!intentHashPattern.test(intentHash)) throw new ProviderError('CALENDAR_INVALID_INTENT_HASH');
    const response = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
      method: 'POST', body: JSON.stringify({ id: eventId, summary: snapshot.title, ...(snapshot.location ? { location: snapshot.location } : {}),
        start: { dateTime: snapshot.start, timeZone: snapshot.timeZone }, end: { dateTime: snapshot.end, timeZone: snapshot.timeZone },
        extendedProperties: { private: { intentHash } } }),
    }, true);
    if (!response.ok) {
      const ambiguous = response.status >= 500 || response.status === 408 || response.status === 409;
      throw new ProviderError(response.status === 409 ? 'CALENDAR_EVENT_EXISTS' : 'CALENDAR_INSERT_REJECTED', ambiguous);
    }
    const event = parseGoogleEvent(await providerJson(response, true), eventId, true);
    if (event.status !== 'confirmed' || event.intentHash !== intentHash || !sameSnapshot(snapshot, event)) throw new ProviderError('CALENDAR_EVENT_MISMATCH', true);
    return event;
  }

  async readCreated(calendarId: string, eventId: string) {
    this.checkCalendar(calendarId); validateId(eventId);
    const owned = await pool().query('SELECT id FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$2 AND event_id=$3', [this.connection.workspace_id, calendarId, eventId]);
    if (!owned.rowCount) throw new ProviderError('CALENDAR_UNOWNED_EVENT');
    const response = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'GET' });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new ProviderError('CALENDAR_READBACK_UNAVAILABLE');
    return parseGoogleEvent(await providerJson(response), eventId, false);
  }
}

export class SimulatedCalendarProvider implements CalendarProvider {
  constructor(private calendarId: string, private workspaceId: string) {}
  private check(id: string) { if (id !== this.calendarId) throw new ProviderError('CALENDAR_MISMATCH'); }
  async queryBusy(calendarId: string, start: string, end: string) {
    this.check(calendarId);
    const result = await pool().query<{ snapshot: EventSnapshot }>(`SELECT snapshot FROM private.va_demo_events WHERE calendar_id=$1 AND status='confirmed'
      AND (snapshot->>'start')::timestamptz < $3::timestamptz AND (snapshot->>'end')::timestamptz > $2::timestamptz`, [calendarId, start, end]);
    return result.rows.map(({ snapshot }) => ({ start: snapshot.start, end: snapshot.end }));
  }
  async insert(calendarId: string, eventId: string, snapshot: EventSnapshot, intentHash: string) {
    this.check(calendarId); validateId(eventId); validateSnapshot(snapshot);
    if (!intentHashPattern.test(intentHash)) throw new ProviderError('CALENDAR_INVALID_INTENT_HASH');
    const inserted = await pool().query(`INSERT INTO private.va_demo_events(calendar_id,event_id,snapshot,intent_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [calendarId, eventId, snapshot, intentHash]);
    if (!inserted.rowCount) throw new ProviderError('CALENDAR_EVENT_EXISTS', true);
    return { ...snapshot, id: eventId, intentHash, status: 'confirmed' as const };
  }
  async readCreated(calendarId: string, eventId: string) {
    this.check(calendarId); validateId(eventId);
    const owned = await pool().query('SELECT id FROM public.va_attempts WHERE workspace_id=$1 AND calendar_id=$2 AND event_id=$3', [this.workspaceId, calendarId, eventId]);
    if (!owned.rowCount) throw new ProviderError('CALENDAR_UNOWNED_EVENT');
    const result = await pool().query<{ snapshot: EventSnapshot; intent_hash: string; status: 'confirmed' | 'cancelled' }>('SELECT snapshot,intent_hash,status FROM private.va_demo_events WHERE calendar_id=$1 AND event_id=$2', [calendarId, eventId]);
    const row = result.rows[0];
    return row ? { ...row.snapshot, id: eventId, intentHash: row.intent_hash, status: row.status } : null;
  }
}

export async function getCalendarProvider(actor: Actor): Promise<CalendarProvider> {
  const result = await pool().query<Connection>("SELECT c.* FROM private.va_calendar_connections c JOIN public.va_workers w ON w.workspace_id=c.workspace_id WHERE w.id=$1 AND w.workspace_id=$2 AND w.active AND c.status='connected'", [actor.id, actor.workspaceId]);
  const conn = result.rows[0];
  if (!conn) throw new ProviderError('CALENDAR_NOT_CONNECTED');
  if (conn.provider === 'internal') return new InternalCalendarProvider(conn.calendar_id,conn.workspace_id,actor);
  if (config().mode === 'demo') {
    if (conn.provider !== 'simulated') throw new ProviderError('CALENDAR_MODE_MISMATCH');
    return new SimulatedCalendarProvider(conn.calendar_id, conn.workspace_id);
  }
  if (conn.provider !== 'google') throw new ProviderError('CALENDAR_MODE_MISMATCH');
  return new GoogleCalendarProvider(conn);
}
