import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard } from '@/lib/http';
import { hqUsers,resetUserActions } from '@/lib/action-quota';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
const resetInput=z.object({userCode:z.string().min(1).max(50)}).strict();
export async function GET(){return api(async()=>({users:await hqUsers(await actor())}));}
export async function POST(request:Request){return api(async()=>{
 mutationGuard(request);const who=await actor(),input=resetInput.parse(await jsonBody(request));
 const users=await hqUsers(who),target=users.find(user=>user.userCode===input.userCode);
 if(!target)throw new AppError('NOT_FOUND','User not found.',404);
 return {quota:await resetUserActions(who,target.id)};
});}
