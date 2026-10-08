import 'server-only';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { createServerClient } from '@supabase/ssr';
import { config, requiredSecret } from './config';
import { pool } from './db';
import { AppError } from './errors';
import type { Actor } from './domain';
export const DEMO_WORKERS = ['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
export async function supabase() {
  const jar=await cookies();
  return createServerClient(requiredSecret('NEXT_PUBLIC_SUPABASE_URL'),requiredSecret('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),{
    cookies:{ getAll:()=>jar.getAll(), setAll:values=>{ for(const {name,value,options} of values) jar.set(name,value,options); } }
  });
}
export async function findActor(id: string): Promise<Actor> {
  const {rows}=await pool().query('SELECT * FROM public.va_workers WHERE id=$1 AND active',[id]);
  const row=rows[0]; if(!row) throw new AppError('UNAUTHORIZED','Your worker account is not active.',401);
  return {id:row.id,workspaceId:row.workspace_id,email:row.email,displayName:row.display_name,userCode:row.user_code,role:row.role,permissions:row.permissions};
}
export async function actor(): Promise<Actor> {
  if(process.env.PILOT_LOGIN==='true') {
    const token=(await cookies()).get('va_pilot_session')?.value;
    if(!token)throw new AppError('UNAUTHORIZED','Sign in to your workspace.',401);
    try{const {payload}=await jwtVerify(token,new TextEncoder().encode(requiredSecret('SESSION_SECRET')),{issuer:'voiceagent-pilot',audience:'voiceagent-web',algorithms:['HS256']});
      const worker=await findActor(payload.sub!);return {...worker,displayName:typeof payload.alias==='string'?payload.alias:worker.displayName};
    }catch{throw new AppError('UNAUTHORIZED','Please sign in again.',401);}
  }
  if(config().mode==='demo') {
    const token=(await cookies()).get('va_demo_session')?.value;
    if(!token) throw new AppError('UNAUTHORIZED','Sign in to your workspace.',401);
    try { const {payload}=await jwtVerify(token,new TextEncoder().encode(requiredSecret('SESSION_SECRET')),{issuer:'voiceagent-demo',audience:'voiceagent-web',algorithms:['HS256']});
      if(!payload.sub || !DEMO_WORKERS.includes(payload.sub)) throw new Error('Invalid worker');
      return await findActor(payload.sub);
    } catch { throw new AppError('UNAUTHORIZED','Please sign in again.',401); }
  }
  const {data,error}=await (await supabase()).auth.getUser();
  if(error || !data.user) throw new AppError('UNAUTHORIZED','Sign in to your workspace.',401);
  return findActor(data.user.id);
}
export async function demoSignIn(id: string) {
  if(config().mode!=='demo' || !DEMO_WORKERS.includes(id)) throw new AppError('NOT_FOUND','Not found.',404);
  const worker=await findActor(id);
  const jwt=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(id).setIssuer('voiceagent-demo').setAudience('voiceagent-web').setIssuedAt().setExpirationTime('8h').sign(new TextEncoder().encode(requiredSecret('SESSION_SECRET')));
  (await cookies()).set('va_demo_session',jwt,{httpOnly:true,sameSite:'lax',secure:new URL(config().origin).protocol==='https:',path:'/',maxAge:28800});
  return worker;
}

export async function pilotSignIn(userCode:string,name:string,code?:string){
 if(process.env.PILOT_LOGIN!=='true')throw new AppError('NOT_FOUND','Not found.',404);
 if(!['user1','user2','admin'].includes(userCode))throw new AppError('INVALID_INPUT','Select an account.',422);
 if(userCode==='admin'){
  const now=new Intl.DateTimeFormat('en-GB',{month:'2-digit',year:'numeric',timeZone:'Asia/Dubai'}).format(new Date()).split('/');
  if(code!==now.join(''))throw new AppError('INVALID_LOGIN','Check the administrator code.',401);
 }
 const result=await pool().query('SELECT id FROM public.va_workers WHERE user_code=$1 AND active',[userCode]);
 if(!result.rows[0])throw new AppError('UNAUTHORIZED','Account is disabled or not configured.',401);
 const worker=await findActor(result.rows[0].id);
 const jwt=await new SignJWT({alias:name}).setProtectedHeader({alg:'HS256'}).setSubject(worker.id).setIssuer('voiceagent-pilot').setAudience('voiceagent-web').setIssuedAt().setExpirationTime('8h').sign(new TextEncoder().encode(requiredSecret('SESSION_SECRET')));
 (await cookies()).set('va_pilot_session',jwt,{httpOnly:true,sameSite:'lax',secure:new URL(config().origin).protocol==='https:',path:'/',maxAge:28800});
 return {...worker,displayName:name};
}
