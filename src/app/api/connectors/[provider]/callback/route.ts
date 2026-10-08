import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { finishConnector } from '@/lib/connectors';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { z } from 'zod';
export async function GET(request:Request,context:{params:Promise<{provider:string}>}){
 try{
  const {provider}=await context.params;const selected=z.enum(['google','outlook']).parse(provider);const url=new URL(request.url);
  if(url.searchParams.has('error'))throw new AppError('CONSENT_DECLINED','Calendar authorization was declined. Return to Settings to retry.',422);
  const state=z.string().min(16).max(128).parse(url.searchParams.get('state'));const code=z.string().min(1).max(4096).parse(url.searchParams.get('code'));
  await finishConnector(selected,state,code);return NextResponse.redirect(config().origin+'/?section=settings&connector=connected');
 }catch(error){return api(async()=>{throw error;});}
}
