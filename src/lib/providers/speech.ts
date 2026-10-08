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
  if (!response.ok) throw new ProviderError('SPEECH_TOKEN_UNAVAILABLE');
  const token = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().max(3600) }).safeParse(await providerJson(response));
  if (!token.success) throw new ProviderError('SPEECH_INVALID_TOKEN');
  endpoint.search = new URLSearchParams({ model: process.env.DEEPGRAM_MODEL || 'nova-3', language: 'en',
    interim_results: 'true', smart_format: 'true', mip_opt_out: 'true' }).toString();
  return { accessToken: token.data.access_token, expiresInSeconds: token.data.expires_in, webSocketUrl: endpoint.toString(), maxDurationSeconds: 120 };
}
