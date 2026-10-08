import { describe,it,expect } from 'vitest';
import { validateSchedule,overlaps } from '../../src/lib/scheduling';
import { emptyFacts } from '../../src/lib/domain';
const full=()=>({...emptyFacts(),intent:'appointment' as const,title:'Inspect site',date:'2030-01-02',time:'10:00',durationMinutes:30,location:'Site A'});
describe('deterministic schedule validation',()=>{
 it('requires explicit duration and location, including explicit N/A',()=>{
   expect(validateSchedule({...full(),durationMinutes:null}).question).toContain('How long');
   expect(validateSchedule({...full(),location:null}).question).toContain('Where');
   expect(validateSchedule({...full(),location:null,locationNotApplicable:true}).snapshot?.location).toBeNull();
 });
 it('rejects invalid dates/times and past instants',()=>{
   expect(validateSchedule({...full(),date:'2030-02-30'}).snapshot).toBeNull();
   expect(validateSchedule({...full(),time:'25:00'}).snapshot).toBeNull();
   expect(validateSchedule({...full(),date:'2020-01-01'}).question).toContain('passed');
 });
 it('uses UAE UTC+4 and allows adjacent intervals',()=>{
   expect(validateSchedule(full()).snapshot?.start).toBe('2030-01-02T06:00:00.000Z');
   expect(overlaps({start:'2030-01-02T06:00Z',end:'2030-01-02T06:30Z'},{start:'2030-01-02T06:30Z',end:'2030-01-02T07:00Z'})).toBe(false);
 });
 it('never turns notes or unsupported intents into a calendar snapshot',()=>{
   expect(validateSchedule({...full(),intent:'note'}).snapshot).toBeNull();
   expect(validateSchedule({...full(),intent:'unsupported'}).snapshot).toBeNull();
 });
});
