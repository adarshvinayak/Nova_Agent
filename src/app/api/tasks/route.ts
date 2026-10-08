import { actorRateLimit } from '@/lib/rate-limit';
import { actor } from '@/lib/auth';
import { api,mutationGuard,jsonBody } from '@/lib/http';
import { tasks,saveTask } from '@/lib/workspace-modules';
export async function GET(request:Request){return api(async()=>tasks(await actor(),new URL(request.url).searchParams.get('scope')==='assigned'));}
export async function POST(request:Request){return api(async()=>{mutationGuard(request);const who=await actor();await actorRateLimit(who,`tasks:${who.id}`,30);return saveTask(who,await jsonBody(request));});}
