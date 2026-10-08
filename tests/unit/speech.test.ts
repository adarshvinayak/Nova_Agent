import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), issue: vi.fn(), limit: vi.fn(),
  worker: { id: '20000000-0000-4000-8000-000000000001', workspaceId: '10000000-0000-4000-8000-000000000001', email: 'test@example.test', displayName: 'Test' } }));
vi.mock('../../src/lib/auth', () => ({ actor: async () => mocks.worker }));
vi.mock('../../src/lib/db', () => ({ actorTransaction: async (_actor: unknown, fn: (db: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }), pool: () => ({ query: mocks.query }) }));
vi.mock('../../src/lib/providers', () => ({ issueSpeechToken: mocks.issue }));
vi.mock('../../src/lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../../src/lib/http')>(), rateLimit: mocks.limit }));
import { POST as token } from '../../src/app/api/speech/token/route';
import { POST as finish } from '../../src/app/api/speech/finish/route';

const sessionId = '30000000-0000-4000-8000-000000000001';
const request = (body: unknown = {}, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/speech/finish', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv('APP_MODE', 'live'); vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  mocks.query.mockReset(); mocks.issue.mockReset(); mocks.limit.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('speech API authorization and usage', () => {
  it('rejects foreign origin before issuing any token or writing records', async () => {
    expect((await token(request({}, 'https://foreign.example'))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('creates durable worker-bound session before minting a temporary token', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: sessionId }], rowCount: 1 });
    mocks.issue.mockImplementationOnce(async () => {
      expect(mocks.query).toHaveBeenCalled();
      return { accessToken: 'temporary', expiresInSeconds: 60, webSocketUrl: 'wss://api.deepgram.com/v1/listen', maxDurationSeconds: 120 };
    });
    const result = await token(request());
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ speechSessionId: sessionId, accessToken: 'temporary' });
    expect(mocks.query.mock.calls[0][1]).toEqual([mocks.worker.workspaceId, mocks.worker.id]);
    expect(mocks.limit).toHaveBeenCalledWith(`speech-token:${mocks.worker.id}`, 5);
  });
  it('marks the durable session failed if credential issuance fails', async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: sessionId }], rowCount: 1 });
    mocks.issue.mockRejectedValueOnce(new Error('synthetic provider failure'));
    expect((await token(request())).status).toBe(503);
    expect(mocks.query.mock.calls[1][0]).toContain("status='failed'");
  });
  it('refuses a foreign speech session before recording usage', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await finish(request({ speechSessionId: sessionId, durationSeconds: 12, status: 'finished' }));
    expect(result.status).toBe(404); expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual([sessionId, mocks.worker.id, mocks.worker.workspaceId]);
  });
  it('records client duration only as unknown-cost estimate, with server-namespaced deduplication', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'issued' }], rowCount: 1 }).mockResolvedValue({ rows: [], rowCount: 1 });
    expect((await finish(request({ speechSessionId: sessionId, durationSeconds: 12, status: 'finished', providerRequestId: 'spoofed-id' }))).status).toBe(200);
    const usage = mocks.query.mock.calls[2];
    expect(usage[0]).toContain("'browser_duration_estimate'"); expect(usage[0]).toContain("'unknown'");
    expect(usage[1]).toContain(`client-estimate:${sessionId}`); expect(usage[1]).not.toContain('spoofed-id');
  });
  it('terminal session replay cannot rewrite duration or create another usage charge', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'finished' }], rowCount: 1 });
    expect((await finish(request({ speechSessionId: sessionId, durationSeconds: 120, status: 'failed' }))).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it('rejects duration beyond recording limit and disables demo token issuance', async () => {
    expect((await finish(request({ speechSessionId: sessionId, durationSeconds: 121, status: 'finished' }))).status).toBe(422);
    vi.stubEnv('APP_MODE', 'demo'); expect((await token(request())).status).toBe(503);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
