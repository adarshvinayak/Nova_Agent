import { actor } from '@/lib/auth';
import { auditOperation } from '@/lib/workspace-modules';
import { cookies } from 'next/headers';
import { api,mutationGuard } from '@/lib/http';
import { config } from '@/lib/config';
import { supabase } from '@/lib/auth';
export async function POST(request:Request) { return api(async()=>{
  mutationGuard(request);try{await auditOperation(await actor(),'auth.logout');}catch{} (await cookies()).delete('va_pilot_session'); if(config().mode==='demo') (await cookies()).delete('va_demo_session');
  else await (await supabase()).auth.signOut(); return {ok:true};
}); }
