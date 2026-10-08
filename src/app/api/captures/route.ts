import { actorRateLimit } from '@/lib/rate-limit';
import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { captureInput } from '@/lib/input';
import { capture,sessionView } from '@/lib/sessions';
import { processSession } from '@/lib/conversation';
export async function POST(request:Request) { return api(async()=>{
  mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await actorRateLimit(worker,'capture:'+worker.id,10);
  const input=captureInput.parse(await jsonBody(request));const saved=await capture(worker,input);
  if(saved.process) await processSession(worker,saved.id);
  return {session:await sessionView(worker,saved.id)};
},201); }
