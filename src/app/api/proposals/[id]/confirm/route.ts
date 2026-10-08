import { moduleTransaction } from '@/lib/workspace-modules';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard,rateLimit } from '@/lib/http';
import { uuid,confirmInput } from '@/lib/input';
import { reserveBooking,executeBooking } from '@/lib/booking';
import { sessionView } from '@/lib/sessions';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(async()=>{
 mutationGuard(request);const worker=await actor();await moduleTransaction(worker,'capture',async()=>{});await rateLimit('confirm:'+worker.id,5);
 const reserved=await reserveBooking(worker,uuid.parse((await params).id),confirmInput.parse(await jsonBody(request)));
 const sessionId=await executeBooking(worker,reserved.id);return {session:await sessionView(worker,sessionId)};
});}
