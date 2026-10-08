import { spawn } from 'node:child_process';
import { productionEnvironment } from './vercel-preflight';

async function cli(args:string[],input?:string){
 return new Promise<void>((resolve,reject)=>{
  const child=spawn('vercel',args,{env:{...process.env,VERCEL_TELEMETRY_DISABLED:'1'},stdio:[input===undefined?'inherit':'pipe','ignore','ignore']});
  if(input!==undefined)child.stdin!.end(input);
  child.on('error',()=>reject(new Error('Vercel CLI is unavailable. Install it and authenticate.')));
  child.on('close',code=>code===0?resolve():reject(new Error(`Vercel operation ${args.slice(0,2).join(' ')} failed. Check authentication, project access and network policy.`)));
 });
}
async function main(){
 const values=productionEnvironment(process.env);
 const scope=process.env.VERCEL_TEAM_SLUG?['--scope',process.env.VERCEL_TEAM_SLUG]:[];
 await cli(['whoami',...scope]);
 await cli(['link','--yes','--project',process.env.VERCEL_PROJECT_NAME??'nova-agent',...scope]);
 for(const [name,value]of Object.entries(values)){
  await cli(['env','add',name,'production','--force','--sensitive','--yes',...scope],value);
  console.log(`Configured ${name} in Vercel production.`);
 }
 console.log('Production configuration is ready. Run vercel deploy --prod --yes to publish.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Vercel setup failed.');process.exitCode=1;});
