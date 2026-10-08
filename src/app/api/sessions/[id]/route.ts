import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { uuid } from '@/lib/input';
import { sessionView } from '@/lib/sessions';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) { return api(async()=>({session:await sessionView(await actor(),uuid.parse((await params).id))})); }
