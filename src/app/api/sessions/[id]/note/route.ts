import { refreshActionQuota } from '@/lib/action-quota';
import { actorRateLimit } from '@/lib/rate-limit';
import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { uuid,noteInput } from '@/lib/input';
import { saveNote,sessionView } from '@/lib/sessions';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) { return api(async()=>{
 mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await actorRateLimit(worker,'note:'+worker.id,10);
 const id=uuid.parse((await params).id);await saveNote(worker,id,noteInput.parse(await jsonBody(request)));return {session:await sessionView(worker,id),quota:await refreshActionQuota(worker)};
}); }
