import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { uuid,noteInput } from '@/lib/input';
import { completeSession,sessionView } from '@/lib/sessions';
import { refreshActionQuota } from '@/lib/action-quota';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return api(async()=>{
 mutationGuard(request);const who=await actor(),id=uuid.parse((await params).id);
 await completeSession(who,id,noteInput.parse(await jsonBody(request)));
 return {session:await sessionView(who,id),quota:await refreshActionQuota(who)};
});}
