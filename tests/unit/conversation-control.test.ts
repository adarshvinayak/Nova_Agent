import { describe, expect, it } from 'vitest';
import { classifyConversationControl } from '../../src/lib/conversation-control';

describe('draft cancellation controls', () => {
  it.each(['Cancel it', 'cancel', 'Never mind!', 'nevermind', 'Please stop this request.', 'Actually, discard the draft', 'Don’t continue', 'Do not proceed with this request', 'Can you cancel it?', 'Cancel this appointment', 'Stop', 'Sorry, forget it, thanks'])('recognizes explicit current-draft command: %s', text => {
    expect(classifyConversationControl(text, true)).toBe('cancel');
  });
  it.each(['Note: cancel it', 'Remember to cancel the subscription', '"cancel it"', 'Change the note to cancel it', 'Assign a task to cancel the supplier call', 'Cancel my appointment booked yesterday', 'Cancel the existing calendar event', 'Cancel tomorrow’s saved appointment', 'Do not cancel it', 'Stop me from forgetting the meeting', 'Cancel it and create a new note', 'The client said cancel it', 'Forget the location; make it online', 'Tell me a joke'])('does not confuse content, ambiguity or saved-event operations with draft control: %s', text => {
    expect(classifyConversationControl(text, true)).toBeNull();
  });
  it('requires an active draft instead of inventing an operation', () => {
    expect(classifyConversationControl('Cancel it', false)).toBeNull();
  });
});
