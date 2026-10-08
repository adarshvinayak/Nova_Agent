import { z } from 'zod';
import { api, jsonBody, mutationGuard, rateLimit } from '@/lib/http';
import { findActor, supabase } from '@/lib/auth';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { hash } from '@/lib/crypto';
const inputSchema=z.object({password:z.string().min(12).max(256),accessToken:z.string().min(1).max(10000).optional(),refreshToken:z.string().min(1).max(10000).optional(),tokenHash:z.string().min(1).max(1024).optional()}).strict().refine(v=>Boolean(v.tokenHash)!==Boolean(v.accessToken&&v.refreshToken));
export async function POST(request:Request){return api(async()=>{
 mutationGuard(request);
 if(config().mode!=='live')throw new AppError('NOT_AVAILABLE','Invitations are available only in the live workspace.',409);
 const input=inputSchema.parse(await jsonBody(request));
 await rateLimit('invite:global',30);
 await rateLimit('invite:'+hash(input.tokenHash??input.accessToken!),5);
 const client=await supabase();
 try{
  const result=input.tokenHash?await client.auth.verifyOtp({token_hash:input.tokenHash,type:'invite'}):await client.auth.setSession({access_token:input.accessToken!,refresh_token:input.refreshToken!});
  if(result.error||!result.data.user)throw new AppError('INVALID_INVITE','This invitation is invalid or has expired. Ask your workspace owner for a new invitation.',401);
  const verified=await client.auth.getUser();
  if(verified.error||!verified.data.user||verified.data.user.id!==result.data.user.id)throw new AppError('INVALID_INVITE','The invitation could not be verified.',401);
  const worker=await findActor(verified.data.user.id);
  const updated=await client.auth.updateUser({password:input.password});
  if(updated.error)throw new AppError('PASSWORD_REJECTED','The password could not be saved. Choose a strong password of at least 12 characters and try again.',422);
  return {worker,mode:'live'};
 }catch(error){await client.auth.signOut({scope:'local'});throw error;}
});}
