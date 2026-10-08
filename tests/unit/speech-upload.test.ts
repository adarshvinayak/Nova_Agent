import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), transcribe: vi.fn(), limit: vi.fn(), worker: { id: '20000000-0000-4000-8000-000000000001', workspaceId: '10000000-0000-4000-8000-000000000001' } }));
vi.mock('../../src/lib/auth', () => ({ actor: async () => mocks.worker }));
vi.mock('../../src/lib/db', () => ({ actorTransaction: async (_: unknown, fn: (db: { query: typeof mocks.query }, member:{role:string;permissions:Record<string,boolean>}) => unknown) => fn({ query: mocks.query },{role:'user',permissions:{capture:true}}), pool: () => ({ query: mocks.query }) }));
vi.mock('../../src/lib/providers/speech', () => ({ transcribeSpeechAudio: mocks.transcribe }));
vi.mock('../../src/lib/rate-limit',()=>({actorRateLimit:mocks.limit}));
vi.mock('../../src/lib/action-quota',()=>({refreshActionQuota:async()=>({remaining:1}),actionQuota:async()=>({remaining:1}),touchAction:async()=>undefined}));
import { POST } from '../../src/app/api/speech/transcribe/route';
const sessionId = '30000000-0000-4000-8000-000000000001';
function request(origin = 'http://localhost:3000', duration = 5, type = 'audio/webm') {
  const form = new FormData(); form.set('speechSessionId', sessionId); form.set('durationSeconds', String(duration));
  form.set('audio', new Blob(['synthetic-audio'], { type }), 'voice.webm');
  return new Request('http://localhost:3000/api/speech/transcribe', { method: 'POST', headers: { origin }, body: form });
}
beforeEach(() => { vi.stubEnv('APP_MODE', 'live'); vi.stubEnv('APP_ORIGIN', 'http://localhost:3000'); mocks.query.mockReset(); mocks.transcribe.mockReset(); mocks.limit.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
describe('bounded authenticated voice uploads', () => {
  it('blocks foreign origins before reading audio or contacting the provider', async () => {
    expect((await POST(request('https://foreign.example'))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it('blocks another worker’s speech session before provider transcription', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await POST(request())).status).toBe(404);
    expect(mocks.query.mock.calls[0][1]).toEqual([sessionId, mocks.worker.id, mocks.worker.workspaceId]);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it('claims a fresh owned session once and returns only transcript/provider metadata', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'issued' }], rowCount: 1 }).mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.transcribe.mockResolvedValueOnce({ transcript: 'Book an inspection', providerRequestId: 'provider-request' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcript: 'Book an inspection', providerRequestId: 'provider-request' });
    expect(mocks.query.mock.calls[1][0]).toContain("status='streaming'");
    expect(mocks.transcribe.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });
  it('rejects replay, excessive duration, and unsupported content', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'streaming' }], rowCount: 1 });
    expect((await POST(request())).status).toBe(409);
    expect((await POST(request(undefined, 121))).status).toBe(422);
    expect((await POST(request(undefined, 5, 'application/octet-stream'))).status).toBe(422);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it('rejects oversized multipart bodies before database or provider operations', async () => {
    expect((await POST(new Request('http://localhost:3000/api/speech/transcribe', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'multipart/form-data; boundary=test' }, body: new Uint8Array(4_032_001) }))).status).toBe(413);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
