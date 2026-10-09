import {it,expect} from 'vitest';
import {emptyFacts} from '../../src/lib/domain';
import {normalizeAssistantFacts,noteTitle} from '../../src/lib/assistant-facts';
it('makes a content-only note ready for review without a separate title question',()=>{
 const body='Discuss the delivery schedule with the supplier.\nKeep the order number for reference.';
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'note',noteText:body,ambiguities:['Please provide a title for the note.']});
 expect(facts.title).toBe('Discuss the delivery schedule with the supplier.');expect(facts.noteText).toBe(body);expect(facts.ambiguities).toEqual([]);
});
it('never fills an explicitly missing note body from a heading',()=>{
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'note',title:'Delivery',noteText:null,ambiguities:['What should the note say?']});
 expect(facts.noteText).toBeNull();expect(facts.ambiguities).toEqual(['What should the note say?']);
});
it('retains explicit headings and bounds generated ones without truncating the body',()=>{
 const body='Long content '.repeat(100);
 expect(noteTitle(body).length).toBeLessThanOrEqual(80);
 expect(normalizeAssistantFacts({...emptyFacts(),intent:'note',title:'  My heading  ',noteText:body})).toMatchObject({title:'My heading',noteText:body.trim()});
});
it('removes resolved missing-field questions but retains genuine contradictions',()=>{
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'appointment',title:'Inspection',date:'2035-01-01',ambiguities:['Please provide an event name.','What date is the appointment?','Which date did you mean, Monday or Tuesday?','Please give a valid time.']});
 expect(facts.ambiguities).toEqual(['Which date did you mean, Monday or Tuesday?','Please give a valid time.']);
});
it('does not demand appointment-only details for tasks',()=>{
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'task',title:'Call supplier',assigneeUserCode:null,ambiguities:['Please provide a duration.','Where will it take place?']});
 expect(facts.ambiguities).toEqual([]);
});
it('preserves an unresolved task recipient and actual missing appointment fields',()=>{
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'task',title:'Call supplier',assigneeUserCode:'unknown',ambiguities:['Who should take this task?']});
 expect(facts.ambiguities).toHaveLength(1);
 expect(normalizeAssistantFacts({...emptyFacts(),intent:'appointment',ambiguities:['What should the appointment be called?']}).ambiguities).toHaveLength(1);
});
it('does not mistake a missing person name inside note content for an optional heading',()=>{
 const facts=normalizeAssistantFacts({...emptyFacts(),intent:'note',noteText:'Send it to the customer.',ambiguities:["Please provide the customer's name."]});
 expect(facts.ambiguities).toEqual(["Please provide the customer's name."]);
});
