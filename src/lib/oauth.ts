import 'server-only';
import { randomBytes,createHash,randomUUID } from 'node:crypto';
import { config,requiredSecret } from './config';
import { constantEqual,hash,encrypt } from './crypto';
import { pool,transaction } from './db';
import { AppError } from './errors';
import { z } from 'zod';

export function requireOwner(request:Request) {
 const supplied=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
 if(!constantEqual(supplied,requiredSecret('OWNER_SETUP_SECRET'))) throw new AppError('UNAUTHORIZED','Owner setup authorization is required.',401);
}
export async function startGoogle(workspaceId:string) {
 if(config().mode!=='live') throw new AppError('LIVE_SETUP_REQUIRED','Switch to a configured live environment to connect Google.',409);
 const workspace=await pool().query('SELECT id FROM public.va_workspaces WHERE id=$1',[workspaceId]);
 if(!workspace.rowCount) throw new AppError('NOT_FOUND','Workspace not found.',404);
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
 await pool().query("INSERT INTO private.va_oauth_states(state_hash,workspace_id,verifier_ciphertext,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[hash(state),workspaceId,encrypt(verifier,workspaceId)]);
 const scope=process.env.GOOGLE_CALENDAR_OWNERSHIP==='owned'?'https://www.googleapis.com/auth/calendar.events.owned':'https://www.googleapis.com/auth/calendar.events';
 const params=new URLSearchParams({client_id:requiredSecret('GOOGLE_CLIENT_ID'),redirect_uri:requiredSecret('GOOGLE_REDIRECT_URI'),response_type:'code',scope:scope+' https://www.googleapis.com/auth/calendar.events.freebusy',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
 return 'https://accounts.google.com/o/oauth2/v2/auth?'+params;
}
export async function finishGoogle(state:string,code:string) {
 const claim=await transaction(async db=>{
   const {rows}=await db.query("UPDATE private.va_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING *",[hash(state)]);
   if(!rows[0])throw new AppError('OAUTH_STATE_EXPIRED','This connection link has expired. Start setup again.',410);return rows[0];
 });
 const {decrypt}=await import('./crypto');
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:requiredSecret('GOOGLE_CLIENT_ID'),client_secret:requiredSecret('GOOGLE_CLIENT_SECRET'),redirect_uri:requiredSecret('GOOGLE_REDIRECT_URI'),grant_type:'authorization_code',code,code_verifier:decrypt(claim.verifier_ciphertext,claim.workspace_id)}),signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new AppError('OAUTH_EXCHANGE_FAILED','Google authorization could not be completed. Start setup again.',503);
 const tokens=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1).optional(),expires_in:z.number().positive(),scope:z.string().optional()}).parse(await response.json());
 const calendarId=requiredSecret('GOOGLE_CALENDAR_ID');
 await transaction(async db=>{
   await db.query('SELECT id FROM public.va_workspaces WHERE id=$1 FOR UPDATE',[claim.workspace_id]);
   const existing=await db.query("SELECT * FROM private.va_calendar_connections WHERE workspace_id=$1 AND status<>'disabled' FOR UPDATE",[claim.workspace_id]);
   const prior=existing.rows[0];
   if(prior&&prior.calendar_id!==calendarId)throw new AppError('CALENDAR_CHANGE_BLOCKED','Reconnect the configured calendar. Changing calendars requires a reviewed migration.',409);
   const id=prior?.id??randomUUID();const refresh=tokens.refresh_token?encrypt(tokens.refresh_token,id):prior?.refresh_token_ciphertext;
   if(!refresh)throw new AppError('OFFLINE_ACCESS_REQUIRED','Google did not grant offline access. Revoke the old application grant and reconnect with consent.',409);
   await db.query(`INSERT INTO private.va_calendar_connections(id,workspace_id,calendar_id,calendar_label,provider,status,scopes,access_token_ciphertext,refresh_token_ciphertext,token_key_version,access_expires_at)
     VALUES($1,$2,$3,$4,'google','connected',$5,$6,$7,1,$8)
     ON CONFLICT(id) DO UPDATE SET provider='google',status='connected',scopes=excluded.scopes,access_token_ciphertext=excluded.access_token_ciphertext,refresh_token_ciphertext=excluded.refresh_token_ciphertext,token_key_version=1,access_expires_at=excluded.access_expires_at`,
     [id,claim.workspace_id,calendarId,process.env.GOOGLE_CALENDAR_LABEL??'Team calendar',tokens.scope?.split(' ')??[],encrypt(tokens.access_token,id),refresh,new Date(Date.now()+tokens.expires_in*1000)]);
   await db.query('UPDATE public.va_workspaces SET config_version=config_version+1 WHERE id=$1',[claim.workspace_id]);
 });
}
