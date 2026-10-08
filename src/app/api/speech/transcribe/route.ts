import { z } from 'zod';
import { actor } from '@/lib/auth';
import { config } from '@/lib/config';
import { actorTransaction } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { api, rateLimit } from '@/lib/http';
import { transcribeSpeechAudio } from '@/lib/providers/speech';

export const maxDuration = 60;
const MAX_AUDIO_BYTES = 4_000_000; // Below Vercel's 4.5 MB request limit, including multipart overhead.
const SUPPORTED_AUDIO = new Set(['audio/webm', 'audio/mp4', 'audio/ogg']);

export async function POST(request: Request) {
  return api(async () => {
    if (request.headers.get('origin') !== config().origin) throw new AppError('INVALID_ORIGIN', 'Please use the application to record a voice message.', 403);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new AppError('INVALID_CONTENT', 'A recorded voice message is required.', 415);
    const worker = await actor();
    await rateLimit(`speech-upload:${worker.id}`, 5);
    const reader = request.body?.getReader();
    if (!reader) throw new AppError('INVALID_INPUT', 'No voice recording was received.', 422);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_AUDIO_BYTES + 32_000) { await reader.cancel(); throw new AppError('TOO_LARGE', 'This recording is too large. Please record a shorter voice message.', 413); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    let form: FormData;
    try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData(); }
    catch { throw new AppError('INVALID_INPUT', 'The voice recording could not be read. Please try again.', 422); }
    const speechSessionId = z.uuid().parse(form.get('speechSessionId'));
    z.coerce.number().finite().min(0).max(120).parse(form.get('durationSeconds'));
    const audio = form.get('audio');
    if (!(audio instanceof File) || !audio.size || audio.size > MAX_AUDIO_BYTES || !SUPPORTED_AUDIO.has(audio.type.split(';')[0])) throw new AppError('INVALID_AUDIO', 'Record a shorter voice message using Safari or Chrome.', 422);
    await actorTransaction(worker, async db => {
      const found = await db.query('SELECT status FROM public.va_speech_sessions WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 AND started_at>now()-interval \'5 minutes\' FOR UPDATE', [speechSessionId, worker.id, worker.workspaceId]);
      if (!found.rowCount) throw new AppError('NOT_FOUND', 'Speech session not found. Tap the microphone to start again.', 404);
      if (found.rows[0].status !== 'issued') throw new AppError('SPEECH_ALREADY_USED', 'This voice recording has already been processed. Start a new recording.', 409);
      await db.query("UPDATE public.va_speech_sessions SET status='streaming' WHERE id=$1 AND worker_id=$2 AND workspace_id=$3", [speechSessionId, worker.id, worker.workspaceId]);
    });
    try {
      // Audio exists only in request memory; neither the application nor database stores it.
      return await transcribeSpeechAudio(new Uint8Array(await audio.arrayBuffer()), audio.type);
    } catch {
      await actorTransaction(worker, db => db.query("UPDATE public.va_speech_sessions SET status='failed',ended_at=now() WHERE id=$1 AND worker_id=$2 AND workspace_id=$3 AND status='streaming'", [speechSessionId, worker.id, worker.workspaceId]));
      throw new AppError('SPEECH_UNAVAILABLE', 'Your voice message could not be transcribed. Tap the microphone to try again.', 503);
    }
  });
}
