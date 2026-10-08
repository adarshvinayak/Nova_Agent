import dotenv from 'dotenv';import pg from 'pg';
import { initializePilot } from './pilot-setup-core';
dotenv.config({path:'.env.local',quiet:true});
async function main(){const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();try{
 await db.query('BEGIN');
 await initializePilot(db);
 await db.query('COMMIT');console.log('Stable pilot accounts and internal calendar ready.');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}}
main().catch(e=>{console.error(e instanceof Error?e.message:'Pilot setup failed');process.exitCode=1;});
