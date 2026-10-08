import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { audit } from '@/lib/workspace-modules';
export async function GET(request:Request){return api(async()=>audit(await actor(),new URL(request.url).searchParams.get('cursor')??undefined));}
