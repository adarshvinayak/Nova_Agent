import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { audit } from '@/lib/workspace-modules';
export async function GET(){return api(async()=>audit(await actor()));}
