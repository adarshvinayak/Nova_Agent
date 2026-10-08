import { actor } from '@/lib/auth';
import { api,mutationGuard,jsonBody,rateLimit } from '@/lib/http';
import { events,saveEvent } from '@/lib/workspace-modules';
export async function GET(request:Request){return api(async()=>{const q=new URL(request.url).searchParams;return events(await actor(),q.get('start')??undefined,q.get('end')??undefined);});}
export async function POST(request:Request){return api(async()=>{mutationGuard(request);const who=await actor();await rateLimit(`events:${who.id}`,30);return saveEvent(who,await jsonBody(request));});}
