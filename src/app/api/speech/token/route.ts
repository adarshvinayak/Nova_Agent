import { actor } from '@/lib/auth';
import { config } from '@/lib/config';
import { actorTransaction } from '@/lib/db';
import { AppError } from '@/lib/errors';
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
    } catch {
      await actorTransaction(worker, db => db.query("UPDATE public.va_speech_sessions SET status='failed',ended_at=now() WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 AND status='issued'", [speechSessionId, worker.id, worker.workspaceId]));
      throw new AppError('SPEECH_UNAVAILABLE', 'Transcription is unavailable. You can type your capture and try the microphone later.', 503);
    }
  });
}
