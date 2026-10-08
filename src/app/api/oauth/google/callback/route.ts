import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { finishGoogle } from '@/lib/oauth';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { z } from 'zod';
export async function GET(request:Request){
 const url=new URL(request.url);
 if(url.searchParams.has('error'))return api(async()=>{throw new AppError('OAUTH_DECLINED','Google access was not granted. You can start setup again.',400);});
 const result=await api(async()=>{const {state,code}=z.object({state:z.string().min(32).max(256),code:z.string().min(1).max(4096)}).parse(Object.fromEntries(url.searchParams));await finishGoogle(state,code);return {ok:true};});
 return result.ok?NextResponse.redirect(config().origin+'/?calendar=connected'):result;
}
