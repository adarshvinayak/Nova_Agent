import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard,rateLimit } from '@/lib/http';
import { uuid,turnInput } from '@/lib/input';
import { submitTurn,sessionView } from '@/lib/sessions';
import { processSession } from '@/lib/conversation';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) { return api(async()=>{
 mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await rateLimit('turn:'+worker.id,10);
 const id=uuid.parse((await params).id);const saved=await submitTurn(worker,id,turnInput.parse(await jsonBody(request)));if(saved.process) await processSession(worker,id);return {session:await sessionView(worker,id)};
}); }
