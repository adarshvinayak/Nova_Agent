import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});

export function productionEnvironment(input:Record<string,string|undefined>):Record<string,string>{
 const database=input.VERCEL_DATABASE_URL??input.SUPABASE_DATABASE_URL;
 if(!database)throw new Error('Configure VERCEL_DATABASE_URL with the Supabase connection string.');
 const url=new URL(database);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname.endsWith('.supabase.co')&& !url.hostname.endsWith('.supabase.com')||!url.password)throw new Error('Production requires an authenticated Supabase PostgreSQL connection.');
 url.searchParams.set('sslmode','verify-full');
 const values:Record<string,string>={APP_MODE:'live',PILOT_LOGIN:'true',LANGUAGE_PROVIDER:'groq',SPEECH_PROVIDER:'deepgram',WORKSPACE_TIME_ZONE:'Asia/Dubai',DATABASE_URL:url.toString(),GROQ_MODEL:input.GROQ_MODEL??'openai/gpt-oss-20b',DEEPGRAM_MODEL:input.DEEPGRAM_MODEL??'nova-3',DEEPGRAM_ENDPOINT:'wss://api.deepgram.com/v1/listen'};
 for(const name of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','GROQ_API_KEY','DEEPGRAM_API_KEY','SESSION_SECRET','TOKEN_ENCRYPTION_KEY','OWNER_SETUP_SECRET']){
  if(!input[name])throw new Error(`Missing production setting: ${name}`);
  values[name]=input[name]!;
 }
 for(const name of ['TOKEN_ENCRYPTION_KEY','SESSION_SECRET','OWNER_SETUP_SECRET'])if(!/^[0-9a-f]{64}$/i.test(values[name]))throw new Error(`${name} must be a random 32-byte hexadecimal secret.`);
 if(new URL(values.NEXT_PUBLIC_SUPABASE_URL).protocol!=='https:')throw new Error('Supabase project URL must use HTTPS.');
 if(input.VERCEL_APP_ORIGIN){const origin=new URL(input.VERCEL_APP_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.hostname==='localhost')throw new Error('VERCEL_APP_ORIGIN must be the production HTTPS origin.');values.APP_ORIGIN=origin.origin;}
 return values;
}
