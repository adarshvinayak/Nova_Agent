import 'server-only';
import type { Actor } from './domain';
import { actorTransaction } from './db';
import { AppError } from './errors';
import { hash } from './crypto';

/** Fresh membership determines exemption; never trust the role cached in a cookie. */
export async function actorRateLimit(actor:Actor,key:string,max=20):Promise<void>{
 const exceeded=await actorTransaction(actor,async(db,member)=>{
  if(member.role==='admin')return false;
  const window=new Date(Math.floor(Date.now()/60000)*60000);
  const {rows}=await db.query(`INSERT INTO private.va_rate_limits(bucket_hash,window_start,request_count,expires_at)
   VALUES($1,$2,1,$2::timestamptz+interval '2 minutes') ON CONFLICT(bucket_hash,window_start)
   DO UPDATE SET request_count=va_rate_limits.request_count+1 RETURNING request_count`,[hash(key),window]);
  return rows[0].request_count>max;
 });
 // Commit rejected attempts too, so repeated retries cannot roll back the bucket.
 if(exceeded)throw new AppError('RATE_LIMIT','Please wait a minute before trying again.',429);
}
