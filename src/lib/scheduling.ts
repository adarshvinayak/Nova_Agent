import { DateTime } from 'luxon';
import type { Facts,EventSnapshot,BusyInterval } from './domain';
export function validateSchedule(facts:Facts,now=new Date()):{question:string|null;snapshot:EventSnapshot|null} {
  const ask=(question:string)=>({question,snapshot:null});
  if(facts.intent==='unsupported') return ask('I can book appointments, save notes, assign tasks, and check your agenda. Changes to saved calendar events aren’t supported.');
  if(facts.intent==='unclear') return ask('I can help with appointments, notes, tasks, or your agenda. What would you like?');
  if(['note','task','agenda'].includes(facts.intent)) return {question:null,snapshot:null};
  if(facts.ambiguities.length) return ask(facts.ambiguities[0]);
  if(!facts.title?.trim()) return ask('What should the appointment be called?');
  if(!facts.date) return ask('What date is the appointment?');
  if(!facts.time) return ask('What time should it start? Please include AM or PM, or use 24-hour time.');
  const start=DateTime.fromISO(`${facts.date}T${facts.time}`,{zone:'Asia/Dubai'});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(facts.date) || !/^\d{2}:\d{2}$/.test(facts.time) || !start.isValid || start.toFormat('yyyy-MM-dd HH:mm')!==`${facts.date} ${facts.time}`) return ask('Please enter a valid date and time.');
  if(start.toMillis()<=now.getTime()) return ask('That time has already passed. What future date and time should I use?');
  if(!facts.durationMinutes) return ask('How long should it last? You can choose 30 minutes or another duration.');
  if(!Number.isInteger(facts.durationMinutes)||facts.durationMinutes<1||facts.durationMinutes>1440) return ask('Choose a duration between 1 minute and 24 hours.');
  if(!facts.location?.trim()&&!facts.locationNotApplicable) return ask('Where will it take place? You can also choose Not applicable.');
  return {question:null,snapshot:{title:facts.title.trim(),location:facts.locationNotApplicable?null:facts.location!.trim(),start:start.toUTC().toISO()!,end:start.plus({minutes:facts.durationMinutes}).toUTC().toISO()!,timeZone:'Asia/Dubai'}};
}
export function overlaps(a:BusyInterval,b:BusyInterval) {return Date.parse(a.start)<Date.parse(b.end)&&Date.parse(a.end)>Date.parse(b.start);}
export function busyMessage(busy:BusyInterval) {
 const start=DateTime.fromISO(busy.start).setZone('Asia/Dubai'),end=DateTime.fromISO(busy.end).setZone('Asia/Dubai');
 return `The calendar is busy on ${start.toFormat('d LLL')} from ${start.toFormat('h:mm a')} to ${end.toFormat('h:mm a')} UAE time. Choose a different time, or save this as a note.`;
}
