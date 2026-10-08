import { actor } from '@/lib/auth';
import { api,mutationGuard,jsonBody,rateLimit } from '@/lib/http';
import { settings,savePermissions } from '@/lib/workspace-modules';
export async function GET(){return api(async()=>settings(await actor()));}
export async function POST(request:Request){return api(async()=>{mutationGuard(request);const who=await actor();await rateLimit(`settings:${who.id}`,30);return savePermissions(who,await jsonBody(request));});}
