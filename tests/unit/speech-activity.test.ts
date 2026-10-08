import { describe, expect, it } from 'vitest';
import { advanceVoiceActivity } from '../../src/lib/speech-activity';

describe('upload speech pause detection', () => {
  it('never submits on initial silence or a short microphone bump', () => {
    let state = { voicedMs: 0, sawVoice: false, lastVoiceAt: 0 };
    expect(advanceVoiceActivity(state, 0, 120_000).shouldStop).toBe(false);
    state = advanceVoiceActivity(state, 0.06, 100);
    expect(advanceVoiceActivity(state, 0, 2000).shouldStop).toBe(false);
  });
  it('waits for established voice activity and a full 1.2 second pause', () => {
    let state = { voicedMs: 0, sawVoice: false, lastVoiceAt: 0 };
    for (const now of [100, 200, 300]) state = advanceVoiceActivity(state, 0.06, now);
    expect(advanceVoiceActivity(state, 0, 1499).shouldStop).toBe(false);
    expect(advanceVoiceActivity(state, 0, 1500).shouldStop).toBe(true);
    state = advanceVoiceActivity(state, 0.06, 1400);
    expect(advanceVoiceActivity(state, 0, 1500).shouldStop).toBe(false);
  });
});
