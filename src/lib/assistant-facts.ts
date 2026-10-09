import type { Facts } from './domain';

/** Titles label notes; their content is the only required input. */
export function noteTitle(body:string):string {
 const heading=body.trim().split(/\r?\n/)[0].replace(/\s+/g,' ').trim();
 return heading.length>80?heading.slice(0,79).trimEnd()+'…':heading;
}

function missingField(question:string):'title'|'date'|'time'|'duration'|'location'|'assignee'|null {
 // Preserve choices, contradictions, invalid values and semantic uncertainties.
 if(/\b(which|either|or|mean|clarify|conflict|ambiguous|multiple|choose|valid|invalid|past|future|am|pm)\b/i.test(question))return null;
 if(!/^(?:please\s+)?(?:provide|give|enter|supply|specify|tell|add|what|where|who|how|a\s+.+\s+is\s+(?:required|missing))/i.test(question.trim()))return null;
 if(/\b(title|heading|called)\b|\b(?:appointment|event|meeting|note|task)\s+name\b|\bname\s+(?:of|for)\s+(?:(?:the|this|your)\s+)?(?:appointment|event|meeting|note|task)\b/i.test(question))return 'title';
 if(/\b(date|day|deadline)\b/i.test(question))return 'date';
 if(/\b(time|when)\b/i.test(question))return 'time';
 if(/\b(duration|long|minutes)\b/i.test(question))return 'duration';
 if(/\b(location|where|place)\b/i.test(question))return 'location';
 if(/\b(assignee|recipient|who|assign)\b/i.test(question))return 'assignee';
 return null;
}

/** Discard only simple missing-field questions resolved by the structured facts. */
export function normalizeAssistantFacts(input:Facts):Facts {
 const facts:Facts={...input,ambiguities:[...input.ambiguities]};
 if(facts.title!==null)facts.title=facts.title.trim()||null;
 if(facts.intent==='note'&&typeof facts.noteText==='string'){
  facts.noteText=facts.noteText.trim()||null;
  if(facts.noteText&&!facts.title)facts.title=noteTitle(facts.noteText);
 }
 facts.ambiguities=facts.ambiguities.filter(question=>{
  const field=missingField(question);if(!field)return true;
  if(facts.intent==='note'&&['title','date','time','duration','location','assignee'].includes(field))return false;
  if(facts.intent==='task'&&['duration','location'].includes(field))return false;
    const resolved={title:!!facts.title,date:!!facts.date,time:!!facts.time,duration:!!facts.durationMinutes,location:!!facts.location?.trim()||facts.locationNotApplicable,assignee:false};
  return !resolved[field];
 });
 return facts;
}
