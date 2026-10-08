export type Actor = { id: string; workspaceId: string; email: string; displayName: string; userCode?: string; role?: 'user'|'admin'; permissions?: Record<string,boolean> };
export type Intent = 'appointment' | 'note' | 'unsupported' | 'unclear';
export type Facts = {
  intent: Intent; title: string | null; date: string | null; time: string | null;
  durationMinutes: number | null; location: string | null; locationNotApplicable: boolean;
  timeZone: string; ambiguities: string[];
};
export const emptyFacts = (): Facts => ({ intent: 'unclear', title: null, date: null, time: null,
  durationMinutes: null, location: null, locationNotApplicable: false, timeZone: 'Asia/Dubai', ambiguities: [] });
export type EventSnapshot = { title: string; location: string | null; start: string; end: string; timeZone: string };
export type AttemptStatus = 'reserved' | 'writing' | 'unknown' | 'succeeded' | 'blocked' | 'failed';
export type SessionState = 'captured' | 'clarifying' | 'ready' | 'confirming' | 'booked' | 'note_saved' | 'booking_unknown' | 'failed';
export type SessionView = {
  id: string; state: SessionState; version: number; facts: Facts; createdAt: string; contentExpired: boolean;
  turns: { id: string; speaker: 'user' | 'assistant'; body: string | null }[];
  proposal: { id: string; version: number; snapshot: EventSnapshot; snapshotHash: string; expiresAt: string } | null;
  attempt: { id: string; status: AttemptStatus; errorCode: string | null } | null;
};
export type BusyInterval = { start: string; end: string };
export type CalendarEvent = EventSnapshot & { id: string; intentHash: string; status: 'confirmed' | 'cancelled' };
export interface CalendarProvider {
  queryBusy(calendarId: string, start: string, end: string): Promise<BusyInterval[]>;
  insert(calendarId: string, eventId: string, snapshot: EventSnapshot, intentHash: string): Promise<CalendarEvent>;
  readCreated(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
}
export type Extraction = { facts: Facts; usage: { requestId: string; inputTokens: number | null; outputTokens: number | null } };
export interface LanguageProvider { extract(text: string, previous: Facts, now: string): Promise<Extraction> }
export type DashboardItem = { id: string; sessionId: string; kind: 'event' | 'note' | 'request'; title: string;
  body: string | null; status: string; startsAt: string | null; createdAt: string; contentExpired: boolean };
