export type Actor = { id: string; workspaceId: string; email: string; displayName: string; userCode?: string; role?: 'user'|'admin'; permissions?: Record<string,boolean> };
export type Intent = 'appointment' | 'note' | 'task' | 'agenda' | 'cancel' | 'unsupported' | 'unclear';
export type AgendaScope = 'next' | 'today' | 'my_tasks' | 'today_tasks' | 'today_appointments' | 'appointments';
export type AgendaSummary = {scope:AgendaScope;label:string;asOf:string;rangeEnd?:string|null;truncated:boolean;items:{id:string;kind:'task'|'appointment';title:string;startsAt:string|null;endsAt?:string|null;userCode:string|null;status:string}[]};
export type TaskDraft = {title:string;assigneeUserCode:string;dueAt:string|null};
export type AssistantContext = {turns:{speaker:'user'|'assistant';body:string}[];users:{userCode:string}[];selfUserCode:string|null};
export type Facts = {
  intent: Intent; title: string | null; date: string | null; time: string | null;
  durationMinutes: number | null; location: string | null; locationNotApplicable: boolean;
  timeZone: string; ambiguities: string[]; assigneeUserCode?: string | null; agendaScope?: AgendaScope | null; noteText?: string | null;
};
export const emptyFacts = (): Facts => ({ intent: 'unclear', title: null, date: null, time: null,
  durationMinutes: null, location: null, locationNotApplicable: false, timeZone: 'Asia/Dubai', ambiguities: [] });
export type EventSnapshot = { title: string; location: string | null; start: string; end: string; timeZone: string };
export type AttemptStatus = 'reserved' | 'writing' | 'unknown' | 'succeeded' | 'blocked' | 'failed';
export type SessionState = 'captured' | 'clarifying' | 'ready' | 'confirming' | 'booked' | 'note_saved' | 'booking_unknown' | 'failed' | 'note_ready' | 'task_ready' | 'task_saved' | 'cancelled' | 'completed' | 'action_expired';
export type SessionView = {
  id: string; state: SessionState; version: number; facts: Facts; createdAt: string; contentExpired: boolean;
  turns: { id: string; speaker: 'user' | 'assistant'; body: string | null }[];
  proposal: { id: string; version: number; snapshot: EventSnapshot; snapshotHash: string; expiresAt: string } | null;
  agenda?: AgendaSummary | null; taskDraft?: TaskDraft | null;
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
export interface LanguageProvider { extract(text: string, previous: Facts, now: string, context?: AssistantContext): Promise<Extraction> }
export type DashboardItem = { id: string; sessionId: string | null; kind: 'event' | 'note' | 'request' | 'task'; title: string;
  body: string | null; status: string; startsAt: string | null; createdAt: string; contentExpired: boolean };
