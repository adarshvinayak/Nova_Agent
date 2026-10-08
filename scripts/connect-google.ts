import { config } from 'dotenv';config({path:'.env.local',quiet:true});
async function main(){
const workspaceId=process.argv[2];
if(!workspaceId||!process.env.OWNER_SETUP_SECRET||!process.env.APP_ORIGIN)throw new Error('Set server config, then npx tsx scripts/connect-google.ts WORKSPACE_UUID');
const response=await fetch(process.env.APP_ORIGIN+'/api/oauth/google/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.APP_ORIGIN,Authorization:'Bearer '+process.env.OWNER_SETUP_SECRET},body:JSON.stringify({workspaceId})});
const body=await response.json();if(!response.ok)throw new Error(body.error?.message??'Connection setup failed');
console.log('Account holder: open this one-use authorization URL (expires in ten minutes):\n'+body.authorizationUrl);
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Setup failed");process.exitCode=1;});
