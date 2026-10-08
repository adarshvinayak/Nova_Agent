import { actorRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { actionQuota,refreshActionQuota,touchAction } from '@/lib/action-quota';
import { actor } from '@/lib/auth';
import { config } from '@/lib/config';
import { actorTransaction } from '@/lib/db';
import { AppError, ProviderError } from '@/lib/errors';
import { api, jsonBody, mutationGuard } from '@/lib/http';
import { issueSpeechToken } from '@/lib/providers';

export async function POST(request: Request) {
  return api(async () => {
    mutationGuard(request);
    const worker = await actor();
    const input=z.object({sessionId:z.uuid().optional()}).strict().parse(await jsonBody(request));
    await refreshActionQuota(worker);
    if (config().mode !== 'live' && process.env.SPEECH_PROVIDER !== 'deepgram') throw new AppError('SPEECH_DEMO_UNAVAILABLE', 'Live transcription needs a configured Deepgram account. Type your capture in this demo.', 503);
    await actorRateLimit(worker,`speech-token:${worker.id}`, 5);
    const speechSessionId = await actorTransaction(worker, async (db,member) => {
      if(member.role!=='admin'&&member.permissions.capture===false)throw new AppError('FORBIDDEN','You do not have access to voice capture.',403);
      if(input.sessionId){
        const owned=await db.query('SELECT id FROM public.va_sessions WHERE id=$1 AND worker_id=$2 AND workspace_id=$3',[input.sessionId,worker.id,worker.workspaceId]);
        if(!owned.rowCount)throw new AppError('NOT_FOUND','Request not found.',404);
        await touchAction(db,worker,input.sessionId);
      }else if((await actionQuota(db,worker)).remaining===0)throw new AppError('ACTION_LIMIT_REACHED','Request limit reached. Contact your admin.',429);
      const result = await db.query("INSERT INTO public.va_speech_sessions(workspace_id,worker_id,provider,action_session_id) VALUES($1,$2,'deepgram',$3) RETURNING id", [worker.workspaceId, worker.id,input.sessionId??null]);
      return result.rows[0].id as string;
    });
    try {
      return { speechSessionId, ...await issueSpeechToken() };
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'SPEECH_UNAVAILABLE';
      await actorTransaction(worker, db => db.query(`WITH failed AS (UPDATE public.va_speech_sessions SET status='failed',ended_at=now() WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 AND status='issued' RETURNING id)
        INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail)
        SELECT $3,$2,id,'speech.provider_failure',$4::jsonb FROM failed`, [speechSessionId,worker.id,worker.workspaceId,{userCode:worker.userCode,alias:worker.displayName,errorCode:code,operation:'token'}]));
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
