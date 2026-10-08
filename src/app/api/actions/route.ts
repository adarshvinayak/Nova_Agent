import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { refreshActionQuota } from '@/lib/action-quota';
export async function GET(){return api(async()=>({quota:await refreshActionQuota(await actor())}));}
