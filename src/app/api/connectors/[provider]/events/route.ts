import { actorRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { externalEvents } from '@/lib/connectors';
import { requireModule } from '@/lib/workspace-modules';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{provider:string}>}){return api(async()=>{
 const user=await actor();await requireModule(user,'calendar');await actorRateLimit(user,'connector-events:'+user.id,30);
 const {provider}=await context.params;const selected=z.enum(['google','outlook','icloud','fastmail']).parse(provider);const url=new URL(request.url);
 return externalEvents(user,selected,url.searchParams.get('start')??'',url.searchParams.get('end')??'',url.searchParams.get('calendarId')??undefined);
});}
