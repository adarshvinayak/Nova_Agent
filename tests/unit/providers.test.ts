import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFacts, type EventSnapshot } from '../../src/lib/domain';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/lib/db', () => ({ pool: () => db }));
import { encrypt } from '../../src/lib/crypto';
import { GoogleCalendarProvider, parseGoogleEvent } from '../../src/lib/providers/calendar';
import { GroqLanguageProvider, SimulatedLanguageProvider } from '../../src/lib/providers/language';
import { issueSpeechToken } from '../../src/lib/providers/speech';

const eventId = 'vc' + '1'.repeat(32);
const intentHash = 'a'.repeat(64);
const snapshot: EventSnapshot = { title: 'Site inspection', location: 'Warehouse 2', start: '2026-10-08T10:00:00+04:00', end: '2026-10-08T10:30:00+04:00', timeZone: 'Asia/Dubai' };
const event = () => ({ id: eventId, status: 'confirmed', summary: snapshot.title, location: snapshot.location,
  start: { dateTime: snapshot.start, timeZone: snapshot.timeZone }, end: { dateTime: snapshot.end, timeZone: snapshot.timeZone },
  extendedProperties: { private: { intentHash } } });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'live'); vi.stubEnv('GROQ_API_KEY', 'synthetic-key'); vi.stubEnv('GROQ_MODEL', 'openai/gpt-oss-20b');
  vi.stubEnv('DEEPGRAM_API_KEY', 'synthetic-key'); vi.stubEnv('TOKEN_ENCRYPTION_KEY', '1'.repeat(64));
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); db.query.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function calendar() {
  const connection = { id: 'connection', calendar_id: 'calendar@example.test', workspace_id: 'workspace', status: 'connected', provider: 'google',
    access_token_ciphertext: encrypt('synthetic-access', 'connection'), refresh_token_ciphertext: encrypt('synthetic-refresh', 'connection'),
    access_expires_at: new Date(Date.now() + 3600_000) };
  db.query.mockResolvedValue({ rows: [connection], rowCount: 1 });
  return new GoogleCalendarProvider(connection);
}

describe('calendar provider boundary', () => {
  it('blocks HTTP-success freebusy responses with nested errors or missing calendar', async () => {
    const provider = calendar();
    fetchMock.mockResolvedValueOnce(reply({ calendars: { 'calendar@example.test': { errors: [{ reason: 'notFound' }], busy: [] } } }));
    await expect(provider.queryBusy('calendar@example.test', snapshot.start, snapshot.end)).rejects.toMatchObject({ code: 'CALENDAR_AVAILABILITY_UNKNOWN' });
    fetchMock.mockResolvedValueOnce(reply({ calendars: {} }));
    await expect(provider.queryBusy('calendar@example.test', snapshot.start, snapshot.end)).rejects.toMatchObject({ code: 'CALENDAR_AVAILABILITY_UNKNOWN' });
  });
  it('treats a lost insert response and 409 as ambiguous, permission denial as definite', async () => {
    const provider = calendar();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(provider.insert('calendar@example.test', eventId, snapshot, intentHash)).rejects.toMatchObject({ ambiguous: true });
    fetchMock.mockResolvedValueOnce(reply({}, 409));
    await expect(provider.insert('calendar@example.test', eventId, snapshot, intentHash)).rejects.toMatchObject({ ambiguous: true, code: 'CALENDAR_EVENT_EXISTS' });
    fetchMock.mockResolvedValueOnce(reply({}, 403));
    await expect(provider.insert('calendar@example.test', eventId, snapshot, intentHash)).rejects.toMatchObject({ ambiguous: false });
  });
  it('requires matching successful event snapshot/hash/status', async () => {
    const provider = calendar();
    fetchMock.mockResolvedValueOnce(reply({ ...event(), summary: 'Changed' }));
    await expect(provider.insert('calendar@example.test', eventId, snapshot, intentHash)).rejects.toMatchObject({ code: 'CALENDAR_EVENT_MISMATCH', ambiguous: true });
    fetchMock.mockResolvedValueOnce(reply(event()));
    await expect(provider.insert('calendar@example.test', eventId, snapshot, intentHash)).resolves.toMatchObject({ id: eventId, intentHash });
    const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request).not.toHaveProperty('attendees'); expect(request).not.toHaveProperty('description');
    expect(request.extendedProperties.private.intentHash).toBe(intentHash);
  });
  it('blocks unpersisted IDs before readback and restricts configured calendar', async () => {
    const provider = calendar(); db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(provider.readCreated('calendar@example.test', eventId)).rejects.toMatchObject({ code: 'CALENDAR_UNOWNED_EVENT' });
    await expect(provider.readCreated('calendar@example.test', 'arbitrary')).rejects.toMatchObject({ code: 'CALENDAR_INVALID_APP_EVENT_ID' });
    await expect(provider.queryBusy('foreign', snapshot.start, snapshot.end)).rejects.toMatchObject({ code: 'CALENDAR_MISMATCH' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not accept unmarked events or tombstones as successful readback', () => {
    expect(() => parseGoogleEvent({ ...event(), extendedProperties: {} }, eventId, false)).toThrow();
    expect(() => parseGoogleEvent({ id: eventId, status: 'cancelled' }, eventId, false)).toThrow();
  });
  it('preserves refresh credential when refresh response omits it', async () => {
    const provider = calendar();
    const conn = (await db.query()).rows[0]; conn.access_expires_at = new Date(0);
    db.query.mockResolvedValue({ rows: [conn], rowCount: 1 });
    fetchMock.mockResolvedValueOnce(reply({ access_token: 'new-access', expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ calendars: { 'calendar@example.test': { busy: [] } } }));
    await provider.queryBusy('calendar@example.test', snapshot.start, snapshot.end);
    const update = db.query.mock.calls.find(([sql]) => String(sql).includes('SET access_token_ciphertext'))!;
    expect(update[1][2]).toBe(conn.refresh_token_ciphertext);
  });
});

describe('language providers', () => {
  it('sends closed strict schema and rejects truncated or schema-invalid facts', async () => {
    const provider = new GroqLanguageProvider();
    fetchMock.mockResolvedValueOnce(reply({ id: 'request', choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
    await expect(provider.extract('book inspection', emptyFacts(), '2026-10-07T00:00:00Z')).rejects.toMatchObject({ code: 'LANGUAGE_INCOMPLETE' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body).not.toHaveProperty('tools');
    fetchMock.mockResolvedValueOnce(reply({ id: 'request', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...emptyFacts(), durationMinutes: -1 }) } }] }));
    await expect(provider.extract('hello', emptyFacts(), '2026-10-07T00:00:00Z')).rejects.toMatchObject({ code: 'LANGUAGE_INVALID_FACTS' });
  });
  it('extracts demonstrative text and targeted followups without a live model', async () => {
    const provider = new SimulatedLanguageProvider();
    const first = await provider.extract('Book site inspection tomorrow at 10:00 for 30 minutes at Warehouse 2', emptyFacts(), '2026-10-07T10:00:00Z');
    expect(first.facts).toMatchObject({ intent: 'appointment', title: 'site inspection', date: '2026-10-08', time: '10:00', durationMinutes: 30, location: 'Warehouse 2' });
    expect(first.usage.requestId).toMatch(/^simulated-language:/);
    const followup = await provider.extract('Not applicable', { ...first.facts, location: null }, '2026-10-07T10:00:00Z');
    expect(followup.facts.locationNotApplicable).toBe(true);
    expect((await provider.extract('reschedule existing event', first.facts, '2026-10-07T10:00:00Z')).facts.intent).toBe('unsupported');
    expect((await provider.extract('Note: call supplier tomorrow', emptyFacts(), '2026-10-07T10:00:00Z')).facts.intent).toBe('note');
  });
});

describe('speech credentials', () => {
  it('issues temporary bearer credential without exposing server key in response/URL', async () => {
    fetchMock.mockResolvedValueOnce(reply({ access_token: 'temporary-jwt', expires_in: 60 }));
    const token = await issueSpeechToken();
    expect(token).toMatchObject({ accessToken: 'temporary-jwt', expiresInSeconds: 60, maxDurationSeconds: 120 });
    expect(token.webSocketUrl).toContain('mip_opt_out=true');
    expect(token.webSocketUrl).not.toContain('token');
    expect(JSON.stringify(token)).not.toContain('synthetic-key');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ttl_seconds: 60 });
  });
  it('rejects demo mode and arbitrary destinations before network requests', async () => {
    vi.stubEnv('DEEPGRAM_ENDPOINT', 'wss://evil.example/v1/listen');
    await expect(issueSpeechToken()).rejects.toMatchObject({ code: 'SPEECH_ENDPOINT_INVALID' });
    vi.stubEnv('APP_MODE', 'demo');
    await expect(issueSpeechToken()).rejects.toMatchObject({ code: 'SPEECH_UNAVAILABLE_IN_DEMO' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
