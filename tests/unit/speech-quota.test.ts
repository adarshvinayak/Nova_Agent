import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({actor:vi.fn(),transaction:vi.fn(),query:vi.fn(),quota:vi.fn(),refresh:vi.fn(),touch:vi.fn(),token:vi.fn(),transcribe:vi.fn(),rate:vi.fn()}));
vi.mock('../../src/lib/auth',()=>({actor:mocks.actor}));
vi.mock('../../src/lib/db',()=>({actorTransaction:mocks.transaction,pool:()=>({query:mocks.query})}));
vi.mock('../../src/lib/action-quota',()=>({actionQuota:mocks.quota,refreshActionQuota:mocks.refresh,touchAction:mocks.touch}));
vi.mock('../../src/lib/rate-limit',()=>({actorRateLimit:mocks.rate}));
vi.mock('../../src/lib/providers',()=>({issueSpeechToken:mocks.token}));
vi.mock('../../src/lib/providers/speech',()=>({transcribeSpeechAudio:mocks.transcribe}));
import {POST as tokenRoute} from '../../src/app/api/speech/token/route';
import {POST as uploadRoute} from '../../src/app/api/speech/transcribe/route';
const worker={id:'20000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000001',displayName:'User One',email:'user@test.local'};
const speechId='30000000-0000-4000-8000-000000000001',sessionId='40000000-0000-4000-8000-000000000001';
const db={query:mocks.query};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('APP_MODE','live');vi.stubEnv('APP_ORIGIN','https://nova.test');
 mocks.actor.mockResolvedValue(worker);mocks.transaction.mockImplementation((_actor,work)=>work(db,{role:'user',permissions:{capture:true}}));
 mocks.refresh.mockResolvedValue({remaining:1});mocks.quota.mockResolvedValue({remaining:1});mocks.touch.mockResolvedValue(undefined);
 mocks.token.mockResolvedValue({accessToken:'temporary-test-token'});mocks.transcribe.mockResolvedValue({transcript:'An inspection request'});
 mocks.query.mockImplementation((sql:string)=>Promise.resolve(sql.includes('INSERT INTO public.va_speech_sessions')?{rows:[{id:speechId}],rowCount:1}:{rows:[{id:sessionId,status:'issued',action_session_id:null}],rowCount:1}));
});
afterEach(()=>vi.unstubAllEnvs());
const token=(body:unknown={})=>new Request('https://nova.test/api/speech/token',{method:'POST',headers:{origin:'https://nova.test','content-type':'application/json'},body:JSON.stringify(body)});
function upload(){const form=new FormData();form.set('speechSessionId',speechId);form.set('durationSeconds','1');form.set('audio',new Blob(['sample audio'],{type:'audio/webm'}),'audio.webm');return new Request('https://nova.test/api/speech/transcribe',{method:'POST',headers:{origin:'https://nova.test'},body:form});}
describe('voice requests respect action authority before calling providers',()=>{
 it('does not issue paid voice access when all request capacity is consumed',async()=>{
  mocks.quota.mockResolvedValue({remaining:0});const response=await tokenRoute(token());expect(response.status).toBe(429);expect((await response.json()).error.code).toBe('ACTION_LIMIT_REACHED');expect(mocks.token).not.toHaveBeenCalled();expect(mocks.refresh).toHaveBeenCalledWith(worker);
 });
 it('links voice issuance to the owned current action and accepts its ongoing activity',async()=>{
  mocks.quota.mockResolvedValue({remaining:0});const response=await tokenRoute(token({sessionId}));expect(response.status).toBe(200);expect(mocks.touch).toHaveBeenCalledWith(db,worker,sessionId);
  const insert=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.va_speech_sessions'));expect(insert?.[1]).toEqual([worker.workspaceId,worker.id,sessionId]);expect(mocks.token).toHaveBeenCalledOnce();
 });
 it('rejects another user session before voice access',async()=>{
  mocks.query.mockResolvedValue({rows:[],rowCount:0});expect((await tokenRoute(token({sessionId}))).status).toBe(404);expect(mocks.token).not.toHaveBeenCalled();
 });
 it('rechecks fresh quota before processing a previously issued unlinked upload',async()=>{
  mocks.quota.mockResolvedValue({remaining:0});const response=await uploadRoute(upload());expect(response.status).toBe(429);expect(mocks.transcribe).not.toHaveBeenCalled();
 });
 it('uses the persisted issuance action instead of any client-supplied action',async()=>{
  mocks.quota.mockResolvedValue({remaining:0});mocks.query.mockResolvedValue({rows:[{status:'issued',action_session_id:sessionId}],rowCount:1});expect((await uploadRoute(upload())).status).toBe(200);expect(mocks.touch).toHaveBeenCalledWith(db,worker,sessionId);expect(mocks.transcribe).toHaveBeenCalledOnce();
 });
 it('enforces revoked capture permission before a provider request',async()=>{
  mocks.transaction.mockImplementation((_actor,work)=>work(db,{role:'user',permissions:{capture:false}}));expect((await tokenRoute(token())).status).toBe(403);expect(mocks.token).not.toHaveBeenCalled();
 });
});
