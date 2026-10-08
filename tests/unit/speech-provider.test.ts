import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSpeechToken, transcribeSpeechAudio } from '../../src/lib/providers/speech';
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('DEEPGRAM_API_KEY', 'server-only-test-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('voice connection diagnostics', () => {
  it.each([[401, 'SPEECH_CREDENTIAL_INVALID'], [402, 'SPEECH_ACCOUNT_CREDIT_REQUIRED'], [429, 'SPEECH_RATE_LIMIT']])('diagnoses grant HTTP %i without exposing provider credentials', async (status, code) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: status as number }));
    await expect(issueSpeechToken()).rejects.toMatchObject({ code });
  });
  it('uses a server upload for restricted keys without exposing the permanent key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const result = await issueSpeechToken();
    expect(result).toEqual({ captureMode: 'upload', maxDurationSeconds: 120, maxAudioBytes: 4_000_000 });
    expect(JSON.stringify(result)).not.toContain('server-only-test-key');
  });
  it('transcribes uploaded audio using the server key without retaining raw audio or exposing it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ metadata: { duration: 5, request_id: 'request-1' }, results: { channels: [{ alternatives: [{ transcript: 'Hello agent' }] }] } })));
    expect(await transcribeSpeechAudio(new Uint8Array([1, 2, 3]), 'audio/mp4')).toEqual({ transcript: 'Hello agent', providerRequestId: 'request-1' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Token server-only-test-key');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('audio/mp4');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api.deepgram.com\/v1\/listen/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ metadata: { duration: 121, request_id: 'request-2' }, results: { channels: [{ alternatives: [{ transcript: 'Too long' }] }] } })));
    await expect(transcribeSpeechAudio(new Uint8Array([1]), 'audio/mp4')).rejects.toMatchObject({ code: 'SPEECH_INVALID_TRANSCRIPT' });
  });
  it('adds punctuation and endpointing while retaining container audio auto-detection', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short-lived-only', expires_in: 60 })));
    const result = await issueSpeechToken();
    const url = new URL(result.webSocketUrl!);
    expect(url.searchParams.get('endpointing')).toBe('300');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(url.searchParams.has('sample_rate')).toBe(false);
    expect(url.searchParams.has('encoding')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('server-only-test-key');
  });
});
