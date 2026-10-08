/** Recognize explicit draft controls without involving a language provider.
 * Anchored commands prevent quoted words, note bodies and saved-event requests
 * from accidentally abandoning the current draft.
 */
export function classifyConversationControl(text: string, hasDraft: boolean): 'cancel' | null {
  if (!hasDraft) return null;
  const input = text.trim().toLowerCase().replace(/’/g, "'")
    .replace(/^[\s,]*(?:(?:please|actually|sorry|no)[\s,]+)+/, '')
    .replace(/[.!?]+$/, '').replace(/(?:[,\s]+(?:please|thanks|thank you))$/, '').trim();
  if (/^(?:never\s*mind|forget it|stop|cancel|abort|don't continue|do not continue|don't proceed|do not proceed)$/.test(input)) return 'cancel';
  if (/^(?:cancel|abort|discard|drop|stop|forget)\s+(?:it|this|that|(?:the |this |current |my )?(?:draft|request|conversation)|(?:this |current )(?:appointment|task|note|booking))$/.test(input)) return 'cancel';
  if (/^(?:i (?:want|would like) to |can you |could you )?(?:cancel|discard|stop)\s+(?:it|this|(?:this |the |my |current )?(?:draft|request|conversation))$/.test(input)) return 'cancel';
  if (/^(?:don't|do not)\s+(?:continue|proceed)(?:\s+with\s+(?:it|this|(?:this |the |my |current )?(?:draft|request|conversation)))$/.test(input)) return 'cancel';
  return null;
}
