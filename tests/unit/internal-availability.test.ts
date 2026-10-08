import { describe,it,expect,vi,beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),events:vi.fn()}));
vi.mock('../../src/lib/connectors',()=>({listConnectors:mocks.list,externalEvents:mocks.events}));
import { connectedBusy } from '../../src/lib/providers/internal-calendar';
const actor={id:'a',workspaceId:'ws',email:'a@test.local',displayName:'Alias'};
beforeEach(()=>vi.clearAllMocks());
describe('external calendar booking availability',()=>{
 it('uses connected calendars only and returns external blocking intervals',async()=>{
  mocks.list.mockResolvedValue([{provider:'google',connected:true},{provider:'outlook',connected:false}]);
  mocks.events.mockResolvedValue({events:[{start:'2027-01-01T10:00:00Z',end:'2027-01-01T11:00:00Z'}],truncated:false});
  expect(await connectedBusy(actor,'2027-01-01T10:00:00Z','2027-01-01T12:00:00Z')).toHaveLength(1);
  expect(mocks.events).toHaveBeenCalledTimes(1);expect(mocks.events.mock.calls[0][1]).toBe('google');
 });
 it('fails closed when connected calendar data cannot be loaded or is incomplete',async()=>{
  mocks.list.mockResolvedValue([{provider:'google',connected:true}]);mocks.events.mockRejectedValue(new Error('Unavailable'));
  await expect(connectedBusy(actor,'2027-01-01T10:00:00Z','2027-01-01T12:00:00Z')).rejects.toThrow('Unavailable');
  mocks.events.mockResolvedValue({events:[],truncated:true});await expect(connectedBusy(actor,'2027-01-01T10:00:00Z','2027-01-01T12:00:00Z')).rejects.toMatchObject({code:'CALENDAR_AVAILABILITY_UNKNOWN'});
 });
});
