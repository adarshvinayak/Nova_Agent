import { config } from '@/lib/config';
import { actor } from '@/lib/auth';
import type { Actor } from '@/lib/domain';
import { Workspace } from '@/components/Workspace';
export const dynamic='force-dynamic';
export default async function Home() {
 const settings=config();
 // Bootstrap authentication in the page response, avoiding a second network trip
 // and a blank client loading screen. Supabase refresh remains in its API handler.
 let worker:Actor|null|undefined;
 if(process.env.PILOT_LOGIN==='true'||settings.mode==='demo') {
  try { worker=await actor(); } catch { worker=null; }
 }
 const speechAvailable=(settings.mode==='live'||process.env.SPEECH_PROVIDER==='deepgram')&&!!process.env.DEEPGRAM_API_KEY;
 return <Workspace initialMode={settings.mode} initialWorker={worker} initialSpeechAvailable={speechAvailable}/>;
}
