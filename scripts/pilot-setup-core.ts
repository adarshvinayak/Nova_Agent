import type { Client,PoolClient } from 'pg';
export async function initializePilot(db:Pick<Client|PoolClient,'query'>){
 const ws='10000000-0000-4000-8000-000000000001';
 await db.query("INSERT INTO va_workspaces(id,name,time_zone) VALUES($1,'Nova Agent','Asia/Dubai') ON CONFLICT(id) DO NOTHING",[ws]);
 await db.query('SELECT id FROM va_workspaces WHERE id=$1 FOR UPDATE',[ws]);
 for(const [n,code,role] of [[1,'user1','user'],[2,'user2','user'],[3,'admin','admin']] as const){
  const id=`20000000-0000-4000-8000-00000000000${n}`;
  await db.query(`INSERT INTO va_workers(id,workspace_id,email,display_name,user_code,role) VALUES($1,$2,$3,$4,$4,$5)
    ON CONFLICT(id) DO UPDATE SET user_code=excluded.user_code,role=excluded.role`,[id,ws,code+'@pilot.local',code,role]);
 }
 const connection=(await db.query("SELECT * FROM private.va_calendar_connections WHERE workspace_id=$1 AND status<>'disabled' FOR UPDATE",[ws])).rows[0];
 if(connection?.provider==='internal'&&connection.calendar_id===`internal:${ws}`)return;
 if((await db.query("SELECT 1 FROM va_attempts WHERE workspace_id=$1 AND status IN ('reserved','writing','unknown')",[ws])).rowCount)throw new Error('Resolve pending bookings before changing calendar.');
 if(connection){
  await db.query("UPDATE private.va_calendar_connections SET calendar_id=$2,calendar_label='Nova Calendar',provider='internal',status='connected' WHERE id=$1",[connection.id,`internal:${ws}`]);
 }else{
  await db.query("INSERT INTO private.va_calendar_connections(workspace_id,calendar_id,calendar_label,provider,status) VALUES($1,$2,'Nova Calendar','internal','connected')",[ws,`internal:${ws}`]);
 }
 await db.query('UPDATE va_workspaces SET config_version=config_version+1 WHERE id=$1',[ws]);
}
