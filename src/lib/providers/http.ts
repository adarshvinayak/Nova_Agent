import 'server-only';
import { ProviderError } from '../errors';

export async function providerRequest(url: string, init: RequestInit, write = false): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ProviderError('PROVIDER_UNREACHABLE', write);
  }
}

export async function providerJson(response: Response, ambiguous = false): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new ProviderError('PROVIDER_INVALID_RESPONSE', ambiguous); }
}
