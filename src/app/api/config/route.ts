import { api } from '@/lib/http';
import { config } from '@/lib/config';
export const dynamic='force-dynamic';
export async function GET() { return api(async()=>({mode:config().mode,timeZone:config().timeZone,pilotLogin:process.env.PILOT_LOGIN==='true',speechAvailable:(config().mode==='live'||process.env.SPEECH_PROVIDER==='deepgram')&&!!process.env.DEEPGRAM_API_KEY})); }
