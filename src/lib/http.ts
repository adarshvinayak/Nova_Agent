import 'server-only';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { config } from './config';
import { pool } from './db';
import { hash } from './crypto';
export function mutationGuard(request: Request) {
  if(request.headers.get('origin')!==config().origin) throw new AppError('INVALID_ORIGIN','Please use the application to perform this action.',403);
  if(!request.headers.get('content-type')?.includes('application/json')) throw new AppError('INVALID_CONTENT','JSON input is required.',415);
}
export async function jsonBody(request: Request) {
  const reader=request.body?.getReader();
  const chunks:Uint8Array[]=[];let bytes=0;
  if(reader)try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>32000){await reader.cancel();throw new AppError('TOO_LARGE','Please shorten your request.',413);}chunks.push(value);
  }}finally{reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new AppError('INVALID_JSON','The request could not be read.',400); }
}
export async function rateLimit(key: string, max=20) {
  const bucket=hash(key); const window=new Date(Math.floor(Date.now()/60000)*60000);
  const {rows}=await pool().query(`INSERT INTO private.va_rate_limits(bucket_hash,window_start,request_count,expires_at)
    VALUES($1,$2,1,$2::timestamptz+interval '2 minutes') ON CONFLICT(bucket_hash,window_start)
    DO UPDATE SET request_count=va_rate_limits.request_count+1 RETURNING request_count`,[bucket,window]);
  if(rows[0].request_count>max) throw new AppError('RATE_LIMIT','Please wait a minute before trying again.',429);
}
export async function api(work:()=>Promise<unknown>, successStatus=200) {
  const requestId=randomUUID(),started=performance.now();
  const headers=()=>({'Cache-Control':'no-store','Server-Timing':`app;dur=${(performance.now()-started).toFixed(1)}`});
  try { const result=await work(); return NextResponse.json({...result as object,requestId},{status:successStatus,headers:headers()}); }
  catch(error) {
    let e:AppError;
    if(error instanceof AppError) e=error;
    else if(error instanceof ZodError) e=new AppError('INVALID_INPUT','Please check the supplied fields.',422);
    else if((error as {code?:string})?.code==='23P01') e=new AppError('CONFLICT','This time overlaps another pilot booking. Choose a different time.',409);
    else { e=new AppError('UNAVAILABLE','The service could not complete this request. Your saved work is preserved.',503); console.error(JSON.stringify({requestId,code:'UNHANDLED',type:error instanceof Error?error.name:'unknown'})); }
    return NextResponse.json({error:{code:e.code,message:e.message},requestId},{status:e.status,headers:headers()});
  }
}
