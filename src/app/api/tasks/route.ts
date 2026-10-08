import { actor } from '@/lib/auth';
import { api,mutationGuard,jsonBody,rateLimit } from '@/lib/http';
import { tasks,saveTask } from '@/lib/workspace-modules';
export async function GET(){return api(async()=>tasks(await actor()));}
export async function POST(request:Request){return api(async()=>{mutationGuard(request);const who=await actor();await rateLimit(`tasks:${who.id}`,30);return saveTask(who,await jsonBody(request));});}
