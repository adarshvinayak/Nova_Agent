import { actor } from '@/lib/auth';
import { config } from '@/lib/config';
import { actorTransaction } from '@/lib/db';
import { AppError, ProviderError } from '@/lib/errors';
import { api, mutationGuard, rateLimit } from '@/lib/http';
import { issueSpeechToken } from '@/lib/providers';

export async function POST(request: Request) {
  return api(async () => {
    mutationGuard(request);
    const worker = await actor();
    if (config().mode !== 'live' && process.env.SPEECH_PROVIDER !== 'deepgram') throw new AppError('SPEECH_DEMO_UNAVAILABLE', 'Live transcription needs a configured Deepgram account. Type your capture in this demo.', 503);
    await rateLimit(`speech-token:${worker.id}`, 5);
    const speechSessionId = await actorTransaction(worker, async db => {
      const result = await db.query("INSERT INTO public.va_speech_sessions(workspace_id,worker_id,provider) VALUES($1,$2,'deepgram') RETURNING id", [worker.workspaceId, worker.id]);
      return result.rows[0].id as string;
    });
    try {
      return { speechSessionId, ...await issueSpeechToken() };
    } catch (error) {
      await actorTransaction(worker, db => db.query("UPDATE public.va_speech_sessions SET status='failed',ended_at=now() WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 AND status='issued'", [speechSessionId, worker.id, worker.workspaceId]));
      const code = error instanceof ProviderError ? error.code : 'SPEECH_UNAVAILABLE';
      const messages: Record<string, string> = {
        SPEECH_CREDENTIAL_INVALID: 'The voice service key is invalid. Ask your administrator to update the Deepgram key.',
        SPEECH_GRANT_PERMISSION_REQUIRED: 'The Deepgram key needs Member or Admin permissions to create temporary voice tokens. Ask your administrator to update it.',
        SPEECH_ACCOUNT_CREDIT_REQUIRED: 'The voice service account needs credits. Ask your administrator to check Deepgram billing.',
        SPEECH_RATE_LIMIT: 'The voice service is busy. Wait a moment and tap the microphone again.',
        PROVIDER_UNREACHABLE: 'The voice service could not be reached. Please try the microphone again shortly.',
      };
      console.error(JSON.stringify({ service: 'speech', code }));
      throw new AppError(code, messages[code] ?? 'Voice is temporarily unavailable. Please try the microphone again shortly.', 503);
    }
  });
}
