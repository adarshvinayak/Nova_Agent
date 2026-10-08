import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});
async function main(){
 const checks:{name:string;url:string;headers:Record<string,string>}[]=[
  {name:'Supabase Auth',url:process.env.NEXT_PUBLIC_SUPABASE_URL+'/auth/v1/health',headers:{apikey:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??''}},
  {name:'Groq',url:'https://api.groq.com/openai/v1/models',headers:{Authorization:'Bearer '+process.env.GROQ_API_KEY}},
  {name:'Deepgram',url:'https://api.deepgram.com/v1/projects',headers:{Authorization:'Token '+process.env.DEEPGRAM_API_KEY}}
 ];
 for(const check of checks)try{const r=await fetch(check.url,{headers:check.headers,signal:AbortSignal.timeout(8000)});console.log(JSON.stringify({provider:check.name,operational:r.ok,httpStatus:r.status}));}catch(error){console.log(JSON.stringify({provider:check.name,operational:false,error:typeof (error as Error&{cause?:{code?:unknown}}).cause?.code==='string'?(error as Error&{cause:{code:string}}).cause.code:'NETWORK_UNAVAILABLE'}));}
}
main().catch(()=>{process.exitCode=1;});
