import { refreshActionQuota } from '@/lib/action-quota';
import { actorRateLimit } from '@/lib/rate-limit';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { uuid,noteInput } from '@/lib/input';
import { confirmTask,sessionView } from '@/lib/sessions';
import { requireModule } from '@/lib/workspace-modules';

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(async()=>{
 mutationGuard(request);const worker=await actor();await requireModule(worker,'capture');await actorRateLimit(worker,'task-confirm:'+worker.id,10);
 const id=uuid.parse((await params).id);await confirmTask(worker,id,noteInput.parse(await jsonBody(request)));
 return {session:await sessionView(worker,id),quota:await refreshActionQuota(worker)};
});}
