import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import type {Actor} from '../../src/lib/domain';
import {resetUserActions} from '../../src/lib/action-quota';
const owners=new WeakMap<Pool,Actor>();
/** Application tests retain ordinary worker permissions; only request allowances reset between cases. */
export async function resetActionFixtures(db:Pool,actors:Actor[],existingOwner?:Actor){
 const ids=(await db.query('SELECT worker_id FROM private.va_action_quotas WHERE worker_id=ANY($1::uuid[])',[actors.map(a=>a.id)])).rows.map(r=>r.worker_id);
 if(!ids.length)return;
 let owner=existingOwner??owners.get(db);
 if(!owner){
  owner={id:randomUUID(),workspaceId:actors[0].workspaceId,email:randomUUID()+'@fixture.test',displayName:'Fixture administrator'};
  await db.query("INSERT INTO va_workers(id,workspace_id,email,display_name,role) VALUES($1,$2,$3,$4,'admin')",[owner.id,owner.workspaceId,owner.email,owner.displayName]);owners.set(db,owner);
 }
 for(const id of ids)await resetUserActions(owner,id);
}
