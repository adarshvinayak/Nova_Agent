import { actorRateLimit } from '@/lib/rate-limit';
import { actor } from '@/lib/auth';
import { api,mutationGuard } from '@/lib/http';
import { uuid } from '@/lib/input';
import { recoverBooking } from '@/lib/booking';
import { sessionView } from '@/lib/sessions';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(async()=>{
 mutationGuard(request);const worker=await actor();await actorRateLimit(worker,'recover:'+worker.id,5);
 const sessionId=await recoverBooking(worker,uuid.parse((await params).id));return {session:await sessionView(worker,sessionId)};
});}
