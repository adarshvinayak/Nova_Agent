import { api } from '@/lib/http';
import { actor } from '@/lib/auth';
import { config } from '@/lib/config';
export const dynamic='force-dynamic';
export async function GET() { return api(async()=>({worker:await actor(),mode:config().mode,timeZone:config().timeZone})); }
