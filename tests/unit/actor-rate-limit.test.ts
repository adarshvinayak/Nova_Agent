import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn()}));
vi.mock('../../src/lib/db',()=>({actorTransaction:mocks.transaction}));
import {actorRateLimit} from '../../src/lib/rate-limit';
const worker={id:'20000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000001',email:'worker@test.local',displayName:'Worker',role:'admin' as const};
beforeEach(()=>{vi.clearAllMocks();mocks.query.mockResolvedValue({rows:[{request_count:6}]});});
describe('authenticated minute throttles use current persisted role',()=>{
 it('ignores a stale admin role claim when persisted membership is a user',async()=>{
  mocks.transaction.mockImplementation((_actor,work)=>work({query:mocks.query},{role:'user'}));await expect(actorRateLimit(worker,'speech:'+worker.id,5)).rejects.toMatchObject({code:'RATE_LIMIT'});expect(mocks.query).toHaveBeenCalledOnce();
 });
 it('exempts a freshly verified administrator even with a stale user role claim',async()=>{
  mocks.transaction.mockImplementation((_actor,work)=>work({query:mocks.query},{role:'admin'}));await expect(actorRateLimit({...worker,role:'user'},'speech:'+worker.id,5)).resolves.toBeUndefined();expect(mocks.query).not.toHaveBeenCalled();
 });
});
