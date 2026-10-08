import { config } from 'dotenv';config({path:'.env.local',quiet:true});
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
async function main(){
const [email,name]=process.argv.slice(2);
if(process.env.APP_MODE!=='live'||!email||!name)throw new Error('Live usage: npx tsx scripts/provision-worker.ts worker@example.com "Worker Name"');
for(const key of ['DATABASE_URL','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'])if(!process.env[key])throw new Error('Missing '+key);
const db=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const workspace=await db.query('SELECT id FROM public.va_workspaces ORDER BY created_at LIMIT 1');
 const workspaceId=workspace.rows[0]?.id??randomUUID();
 if(!workspace.rowCount)await db.query("INSERT INTO public.va_workspaces(id,name,time_zone) VALUES($1,'AiRK Solutions','Asia/Dubai')",[workspaceId]);
 const client=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await client.auth.admin.inviteUserByEmail(email,{redirectTo:process.env.APP_ORIGIN+'/auth/accept'});
 if(error||!data.user)throw new Error('Invitation failed. Check configured SMTP and Supabase access.');
 await db.query(`INSERT INTO public.va_workers(id,workspace_id,email,display_name) VALUES($1,$2,$3,$4)
   ON CONFLICT(id) DO UPDATE SET active=true,display_name=excluded.display_name`,[data.user.id,workspaceId,email,name]);
 console.log('Worker invited. Workspace ID:',workspaceId);
}finally{await db.end();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Setup failed");process.exitCode=1;});
