import { actor } from '@/lib/auth';
import { api } from '@/lib/http';
import { dashboard } from '@/lib/sessions';
import { z } from 'zod';
export async function GET(request:Request) { return api(async()=>{const url=new URL(request.url);return dashboard(await actor(),z.enum(['all','event','note','request','task']).parse(url.searchParams.get('type')??'all'),url.searchParams.get('cursor')??undefined);}); }
