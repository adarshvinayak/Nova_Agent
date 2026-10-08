import { actorTransaction } from '@/lib/db';
import { refreshActionQuota,touchAction } from '@/lib/action-quota';
import { actorRateLimit } from '@/lib/rate-limit';
import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,mutationGuard } from '@/lib/http';
import { uuid } from '@/lib/input';
import { sessionView } from '@/lib/sessions';
import { processSession } from '@/lib/conversation';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(async()=>{
 mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await actorRateLimit(worker,'resume:'+worker.id,5);const id=uuid.parse((await params).id);
 await refreshActionQuota(worker);await actorTransaction(worker,db=>touchAction(db,worker,id));
 await processSession(worker,id);return {session:await sessionView(worker,id),quota:await refreshActionQuota(worker)};
});}
