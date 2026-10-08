export type VoiceActivity = { voicedMs: number; sawVoice: boolean; lastVoiceAt: number };

/** A conservative local pause detector for upload-only transcription. */
export function advanceVoiceActivity(state: VoiceActivity, rms: number, now: number) {
  const voiced = rms >= 0.025;
  const voicedMs = voiced ? state.voicedMs + 100 : state.sawVoice ? state.voicedMs : 0;
  const sawVoice = state.sawVoice || voicedMs >= 300;
  const lastVoiceAt = voiced ? now : state.lastVoiceAt;
  return { voicedMs, sawVoice, lastVoiceAt, shouldStop: sawVoice && !voiced && now - lastVoiceAt >= 1200 };
}
