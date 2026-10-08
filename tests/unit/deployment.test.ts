import { afterEach,it,expect,vi } from 'vitest';
import { productionEnvironment } from '../../scripts/vercel-preflight';
import { config } from '../../src/lib/config';
const inputs={SUPABASE_DATABASE_URL:'postgresql://postgres:fixture@db.fixture.supabase.co:5432/postgres',NEXT_PUBLIC_SUPABASE_URL:'https://fixture.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fixture',GROQ_API_KEY:'fixture',DEEPGRAM_API_KEY:'fixture',SESSION_SECRET:'1'.repeat(64),TOKEN_ENCRYPTION_KEY:'2'.repeat(64),OWNER_SETUP_SECRET:'3'.repeat(64),DATABASE_URL:'postgresql://localhost/local',TEST_DATABASE_URL:'postgresql://localhost/local_test',APP_ORIGIN:'http://localhost:3000'};
afterEach(()=>vi.unstubAllEnvs());
it('uses the remote database with certificate verification and never exports local database or test settings',()=>{
 const values=productionEnvironment(inputs);expect(values.APP_MODE).toBe('live');expect(new URL(values.DATABASE_URL).hostname).toBe('db.fixture.supabase.co');expect(new URL(values.DATABASE_URL).searchParams.get('sslmode')).toBe('verify-full');expect(values.TEST_DATABASE_URL).toBeUndefined();expect(values.APP_ORIGIN).toBeUndefined();
});
it('blocks deployment with absent credentials or a local database',()=>{
 expect(()=>productionEnvironment({...inputs,GROQ_API_KEY:''})).toThrow('GROQ_API_KEY');expect(()=>productionEnvironment({...inputs,SUPABASE_DATABASE_URL:'postgresql://postgres:fixture@localhost/db'})).toThrow('Supabase');
});
it('resolves the Vercel production origin and rejects unsafe hosted configuration',()=>{
 vi.stubEnv('APP_ORIGIN',undefined);vi.stubEnv('APP_MODE','live');vi.stubEnv('VERCEL','1');vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL','nova-fixture.vercel.app');expect(config().origin).toBe('https://nova-fixture.vercel.app');vi.stubEnv('APP_MODE','demo');expect(()=>config()).toThrow('Vercel requires');
});
