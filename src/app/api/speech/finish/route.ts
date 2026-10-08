import { actorRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { actor } from '@/lib/auth';
import { actorTransaction } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { api, jsonBody, mutationGuard } from '@/lib/http';

const inputSchema = z.object({ speechSessionId: z.uuid(), durationSeconds: z.number().finite().min(0).max(120),
  status: z.enum(['finished', 'failed', 'abandoned']), transcript:z.string().max(8000).optional(), failureReason:z.string().max(500).optional(), endMode:z.enum(['manual','auto']).optional(), endReason:z.enum(['manual','pause','limit','error','abandoned']).optional(), captureMode:z.enum(['stream','upload']).optional(), providerRequestId: z.string().max(128).regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict();

export async function POST(request: Request) {
  return api(async () => {
    mutationGuard(request); const worker = await actor(); await actorRateLimit(worker,`speech-finish:${worker.id}`, 10);
    const input = inputSchema.parse(await jsonBody(request));
    return actorTransaction(worker, async db => {
      const selected = await db.query('SELECT status FROM public.va_speech_sessions WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 FOR UPDATE', [input.speechSessionId, worker.id, worker.workspaceId]);
      if (!selected.rowCount) throw new AppError('NOT_FOUND', 'Speech session not found.', 404);
      if (!['issued', 'streaming'].includes(selected.rows[0].status)) return { status: selected.rows[0].status };
      await db.query(`UPDATE public.va_speech_sessions SET status=$4,ended_at=now(),audio_seconds=$5,provider_request_id=$6
        WHERE id=$1 AND worker_id=$2 AND workspace_id=$3`, [input.speechSessionId, worker.id, worker.workspaceId, input.status, input.durationSeconds, input.providerRequestId ?? null]);
      // Browser duration is only a client estimate, not an authoritative provider bill.
      // A server-generated namespace prevents a spoofed provider ID suppressing another worker's usage.
      await db.query(`INSERT INTO public.va_usage_events(workspace_id,worker_id,speech_session_id,provider,provider_request_id,operation,audio_seconds,cost_status)
        VALUES($1,$2,$3,'deepgram',$4,'browser_duration_estimate',$5,'unknown') ON CONFLICT DO NOTHING`,
      [worker.workspaceId, worker.id, input.speechSessionId, `client-estimate:${input.speechSessionId}`, input.durationSeconds]);
      await db.query(`INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail,content)
        VALUES($1,$2,$3,'speech.completed',$4,$5)`,[worker.workspaceId,worker.id,input.speechSessionId,
        {userCode:worker.userCode??'worker',alias:worker.displayName,source:'browser_voice',status:input.status,endMode:input.endMode,endReason:input.endReason,captureMode:input.captureMode,failureReason:input.failureReason,durationSeconds:input.durationSeconds,clientReported:true},
        input.transcript?{text:input.transcript}:{}]);
      return { status: input.status };
    });
  });
}
