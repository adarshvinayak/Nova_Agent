import { refreshActionQuota } from '@/lib/action-quota';
import { actorRateLimit } from '@/lib/rate-limit';
import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { uuid,editInput } from '@/lib/input';
import { editFacts,sessionView } from '@/lib/sessions';
import { processSession } from '@/lib/conversation';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) { return api(async()=>{
 mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await actorRateLimit(worker,'edit:'+worker.id,10);
 const id=uuid.parse((await params).id);const saved=await editFacts(worker,id,editInput.parse(await jsonBody(request)));if(saved.process) await processSession(worker,id,false);return {session:await sessionView(worker,id),quota:await refreshActionQuota(worker)};
}); }
