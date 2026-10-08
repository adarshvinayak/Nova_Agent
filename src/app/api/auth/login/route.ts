import { auditOperation } from '@/lib/workspace-modules';
import { z } from 'zod';
import { api,jsonBody,mutationGuard,rateLimit } from '@/lib/http';
import { demoSignIn,findActor,supabase,pilotSignIn } from '@/lib/auth';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
const body=z.object({userCode:z.enum(['user1','user2','admin']).optional(),name:z.string().trim().min(1).max(80).optional(),code:z.string().max(20).optional(),workerId:z.string().uuid().optional(),email:z.string().email().optional(),password:z.string().min(1).max(256).optional()});
export async function POST(request:Request) { return api(async()=>{
  mutationGuard(request); const input=body.parse(await jsonBody(request));
  await rateLimit('login:'+ (input.email??input.workerId??'invalid'),10);
  if(process.env.PILOT_LOGIN==='true'){await rateLimit('pilot-login:global',30);if(!input.userCode||!input.name)throw new AppError('INVALID_INPUT','Select an account and enter your name.',422);const worker=await pilotSignIn(input.userCode,input.name,input.code);await auditOperation(worker,'auth.login');return {worker,mode:config().mode};}
  if(config().mode==='demo') return {worker:await demoSignIn(input.workerId??''),mode:'demo'};
  if(!input.email || !input.password) throw new AppError('INVALID_INPUT','Enter your email and password.',422);
  const client=await supabase(); const {data,error}=await client.auth.signInWithPassword({email:input.email,password:input.password});
  if(error || !data.user) throw new AppError('INVALID_LOGIN','Check your email and password.',401);
  try { return {worker:await findActor(data.user.id),mode:'live'}; } catch(error) { await client.auth.signOut(); throw error; }
}); }
