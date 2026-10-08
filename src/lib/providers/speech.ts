import 'server-only';
import { z } from 'zod';
import { config, requiredSecret } from '../config';
import { ProviderError } from '../errors';
import { providerJson, providerRequest } from './http';

export async function issueSpeechToken() {
  if (config().mode === 'demo' && process.env.SPEECH_PROVIDER !== 'deepgram') throw new ProviderError('SPEECH_UNAVAILABLE_IN_DEMO');
  const endpoint = new URL(process.env.DEEPGRAM_ENDPOINT || 'wss://api.deepgram.com/v1/listen');
  if (endpoint.protocol !== 'wss:' || !['api.deepgram.com', 'api.eu.deepgram.com'].includes(endpoint.hostname) || endpoint.pathname !== '/v1/listen' || endpoint.username || endpoint.password || endpoint.port) throw new ProviderError('SPEECH_ENDPOINT_INVALID');
  endpoint.search = '';
  const response = await providerRequest(`https://${endpoint.hostname}/v1/auth/grant`, {
    method: 'POST', headers: { Authorization: `Token ${requiredSecret('DEEPGRAM_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!response.ok) {
    if (response.status === 401) throw new ProviderError('SPEECH_CREDENTIAL_INVALID');
    // Restricted keys can transcribe audio but cannot mint browser credentials.
    // Keep the permanent key server-side and use a bounded audio upload instead.
    if (response.status === 403) return { captureMode: 'upload' as const, maxDurationSeconds: 120, maxAudioBytes: 4_000_000 };
    if (response.status === 402) throw new ProviderError('SPEECH_ACCOUNT_CREDIT_REQUIRED');
    if (response.status === 429) throw new ProviderError('SPEECH_RATE_LIMIT');
    throw new ProviderError('SPEECH_TOKEN_UNAVAILABLE');
  }
  const token = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().max(3600) }).safeParse(await providerJson(response));
  if (!token.success) throw new ProviderError('SPEECH_INVALID_TOKEN');
  endpoint.search = new URLSearchParams({ model: process.env.DEEPGRAM_MODEL || 'nova-3', language: 'en',
    interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300', mip_opt_out: 'true' }).toString();
  return { accessToken: token.data.access_token, expiresInSeconds: token.data.expires_in, webSocketUrl: endpoint.toString(), maxDurationSeconds: 120 };
}


export async function transcribeSpeechAudio(audio: Uint8Array, mimeType: string) {
  const endpoint = new URL(process.env.DEEPGRAM_ENDPOINT || 'wss://api.deepgram.com/v1/listen');
  if (endpoint.protocol !== 'wss:' || !['api.deepgram.com', 'api.eu.deepgram.com'].includes(endpoint.hostname) || endpoint.pathname !== '/v1/listen' || endpoint.username || endpoint.password || endpoint.port) throw new ProviderError('SPEECH_ENDPOINT_INVALID');
  endpoint.protocol = 'https:';
  endpoint.search = new URLSearchParams({ model: process.env.DEEPGRAM_MODEL || 'nova-3', language: 'en', smart_format: 'true', punctuate: 'true', mip_opt_out: 'true' }).toString();
  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(35_000),
      headers: { Authorization: `Token ${requiredSecret('DEEPGRAM_API_KEY')}`, 'Content-Type': mimeType }, body: audio as BodyInit });
  } catch { throw new ProviderError('PROVIDER_UNREACHABLE'); }
  if (!response.ok) throw new ProviderError(response.status === 401 ? 'SPEECH_CREDENTIAL_INVALID' : 'SPEECH_TRANSCRIPTION_UNAVAILABLE');
  const parsed = z.object({ metadata: z.object({ duration: z.number().finite().min(0).max(120), request_id: z.string().max(128).regex(/^[a-zA-Z0-9_-]+$/) }),
    results: z.object({ channels: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string().max(8000) })).min(1) })).min(1) }) }).safeParse(await providerJson(response));
  if (!parsed.success) throw new ProviderError('SPEECH_INVALID_TRANSCRIPT');
  return { transcript: parsed.data.results.channels[0].alternatives[0].transcript.trim(), providerRequestId: parsed.data.metadata.request_id };
}
