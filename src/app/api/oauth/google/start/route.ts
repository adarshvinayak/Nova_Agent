import { z } from 'zod';
import { api,jsonBody,mutationGuard,rateLimit } from '@/lib/http';
import { requireOwner,startGoogle } from '@/lib/oauth';
export async function POST(request:Request){return api(async()=>{
 mutationGuard(request);requireOwner(request);const {workspaceId}=z.object({workspaceId:z.string().uuid()}).strict().parse(await jsonBody(request));
 await rateLimit('oauth:'+workspaceId,5);return {authorizationUrl:await startGoogle(workspaceId)};
});}
