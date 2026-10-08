'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square } from 'lucide-react';
import { advanceVoiceActivity } from '@/lib/speech-activity';

export type SpeechPhase = 'idle' | 'starting' | 'recording' | 'stopping';
type Props = { onTranscript: (text: string, metadata?: { complete: boolean }) => void; disabled?: boolean; mode: 'demo' | 'live'; onRecordingChange?: (active: boolean) => void; onPhaseChange?: (phase: SpeechPhase) => void; onPreview?: (text: string) => void; onStatus?: (message: string) => void; endMode?: 'manual' | 'auto'; compact?: boolean };
type Phase = SpeechPhase;
type Run = { stream: MediaStream | null; socket: WebSocket | null; recorder: MediaRecorder | null;
  sessionId: string | null; stoppedAt?:number; endReason?:'manual'|'pause'|'limit'; captureMode?: 'stream'|'upload'; started: number; final: Map<string, string>; providerRequestId?: string;
  ended: boolean; stopping: boolean; failure: string | null; maxTimer?: ReturnType<typeof setTimeout>; drainTimer?: ReturnType<typeof setTimeout>; vadTimer?: ReturnType<typeof setInterval>; audioContext?: AudioContext; sawVoice?: boolean; voicedMs?: number; lastVoiceAt?: number };

export function SpeechCapture({ onTranscript, disabled = false, mode, onRecordingChange, onPhaseChange, onPreview, onStatus, endMode = 'manual', compact = false }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');
  const current = useRef<Run | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onTranscript, onRecordingChange, onPhaseChange, onPreview, onStatus });
  callbacks.current = { onTranscript, onRecordingChange, onPhaseChange, onPreview, onStatus };

  function report(message: string) { setMessage(message); callbacks.current.onStatus?.(message); }
  function updatePreview(text: string) { setPreview(text); callbacks.current.onPreview?.(text); }

  function updatePhase(next: Phase) { setPhase(next); callbacks.current.onPhaseChange?.(next); }

  function finish(run: Run, abandoned = false) {
    if (run.ended) return;
    run.ended = true;run.stoppedAt??=Date.now();
    clearTimeout(run.maxTimer); clearTimeout(run.drainTimer); clearInterval(run.vadTimer);
    void run.audioContext?.close().catch(() => undefined);
    if (run.recorder?.state === 'recording') run.recorder.stop();
    run.stream?.getTracks().forEach(track => track.stop());
    if (run.socket && run.socket.readyState < WebSocket.CLOSING) run.socket.close();
    const text = [...run.final.values()].join(' ').trim();
    if (run.sessionId) {
      void fetch('/api/speech/finish', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speechSessionId: run.sessionId,
          durationSeconds: run.started ? Math.min(120, Math.max(0, ((run.stoppedAt??Date.now()) - run.started) / 1000)) : 0,
          status: abandoned ? 'abandoned' : run.failure ? 'failed' : 'finished', providerRequestId: run.providerRequestId, transcript: text || undefined, failureReason: run.failure ?? undefined, endMode, endReason:abandoned?'abandoned':run.failure?'error':run.endReason, captureMode: run.captureMode }) }).catch(() => undefined);
    }
    if (current.current === run) current.current = null;
    if (mounted.current && !abandoned) {
      updatePhase('idle'); updatePreview('');
      if (text) callbacks.current.onTranscript(text, { complete: !run.failure && run.stopping });
      callbacks.current.onRecordingChange?.(false);
      report(run.failure ?? (text ? 'Voice message ready.' : 'No speech detected. Tap the microphone and try again.'));
    }
  }

  function stop(run: Run,reason:'manual'|'pause'|'limit'='manual') {
    if (run.ended || run.stopping) return;
    run.stopping = true;run.endReason=reason;run.stoppedAt=Date.now(); clearTimeout(run.maxTimer);
    if (mounted.current) updatePhase('stopping');
    // onstop follows the final dataavailable event, preserving recorder chunk order.
    if (run.recorder?.state === 'recording') run.recorder.stop();
    else finish(run);
    run.stream?.getTracks().forEach(track => track.stop());
  }

  function startSilenceDetection(run: Run, stream: MediaStream) {
    // Upload-only keys have no interim transcript. Detect pauses locally; audio never leaves
    // the existing Deepgram path, and silence before actual voice activity cannot submit.
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) { report('Automatic pause detection is unavailable in this browser. Tap the microphone to finish.'); return; }
      const context = run.audioContext ?? new AudioContextClass(); run.audioContext = context;
      void context.resume().then(() => { if (context.state !== 'running' && !run.ended) report('Automatic pause detection is unavailable. Tap the microphone to finish.'); }).catch(() => { if (!run.ended) report('Automatic pause detection is unavailable. Tap the microphone to finish.'); });
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      run.vadTimer = setInterval(() => {
        if (run.ended || run.stopping) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const next = advanceVoiceActivity({ voicedMs: run.voicedMs ?? 0, sawVoice: run.sawVoice ?? false, lastVoiceAt: run.lastVoiceAt ?? 0 }, rms, Date.now());
        run.voicedMs = next.voicedMs; run.sawVoice = next.sawVoice; run.lastVoiceAt = next.lastVoiceAt;
        if (next.shouldStop) stop(run,'pause');
      }, 100);
    } catch { report('Automatic pause detection is unavailable. Tap the microphone to finish.'); }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (current.current) finish(current.current, true); };
    // Each run uses callbacks.current so cleanup is independent of callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (current.current || disabled || mode !== 'live') return;
    const run: Run = { stream: null, socket: null, recorder: null, sessionId: null, started: 0,
      final: new Map(), ended: false, stopping: false, failure: null };
    current.current = run; updatePhase('starting'); report(''); updatePreview(''); callbacks.current.onRecordingChange?.(true);
    try {
      if (!window.isSecureContext) throw new Error('Microphone access needs HTTPS. Open the secure deployed app, or use localhost on this device.');
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is not supported in this browser. Open the app in Safari or Chrome.');
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser cannot encode microphone audio. Try the latest Safari or Chrome.');
      // Safari requires AudioContext activation in the original tap gesture, before awaiting
      // microphone permission or network responses. It is used only if upload needs local VAD.
      if (endMode === 'auto') {
        try {
          const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AudioContextClass) { run.audioContext = new AudioContextClass(); void run.audioContext.resume().catch(() => undefined); }
        } catch { /* Manual finishing remains available if local pause detection is unsupported. */ }
      }
      // Start authorization alongside the permission prompt, rather than adding its latency afterwards.
      // A late issued session is closed even if permission is denied or this component unmounts.
      const tokenPromise = fetch('/api/speech/token', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(12_000) })
        .then(async response => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error?.message || 'Voice service is temporarily unavailable. Please try again.');
          if (typeof data.speechSessionId !== 'string' || (data.captureMode !== 'upload' && (typeof data.accessToken !== 'string' || typeof data.webSocketUrl !== 'string'))) throw new Error('Transcription could not connect. Please try again.');
          run.sessionId = data.speechSessionId;run.captureMode=data.captureMode==='upload'?'upload':'stream';
          if (run.ended) void fetch('/api/speech/finish', { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speechSessionId: run.sessionId, durationSeconds: 0, status: 'abandoned', failureReason: run.failure ?? undefined, endMode, endReason:run.failure?'error':'abandoned',captureMode: run.captureMode }) }).catch(() => undefined);
          return { data, error: null };
        }).catch(error => ({ data: null, error }));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (run.ended) { stream.getTracks().forEach(track => track.stop()); return; }
      run.stream = stream;
      const tokenResult = await tokenPromise;
      if (run.ended) return;
      if (tokenResult.error) throw tokenResult.error;
      const data = tokenResult.data!;
      if (data.captureMode === 'upload') {
        const chunks: Blob[] = []; let audioBytes = 0;
        const recorder = new MediaRecorder(stream, { mimeType }); run.recorder = recorder;
        recorder.ondataavailable = event => {
          if (run.ended || !event.data.size) return;
          audioBytes += event.data.size;
          if (audioBytes > 4_000_000) { run.failure = 'This voice message is too large. Please record a shorter request.'; finish(run); return; }
          chunks.push(event.data);
        };
        recorder.onerror = () => { run.failure = 'Your recording was interrupted. Tap the microphone to try again.'; finish(run); };
        recorder.onstop = () => {
          if (run.ended) return;
          if(!run.stopping)run.failure='Recording was interrupted. Review the transcript before sending.';
          run.stoppedAt??=Date.now();updatePhase('stopping');
          const form = new FormData();
          form.set('speechSessionId', run.sessionId!);
          form.set('durationSeconds', String(Math.min(120, ((run.stoppedAt??Date.now()) - run.started) / 1000)));
          form.set('audio', new Blob(chunks, { type: mimeType }), 'voice-message');
          void fetch('/api/speech/transcribe', { method: 'POST', credentials: 'same-origin', body: form, signal: AbortSignal.timeout(45_000) })
            .then(async response => {
              const result = await response.json();
              if (!response.ok) throw new Error(result.error?.message || 'Voice processing failed. Tap the microphone to try again.');
              if (run.ended) return;
              if (typeof result.transcript !== 'string') throw new Error('Voice processing returned an invalid response. Please try again.');
              run.final.set('upload', result.transcript);
              if (typeof result.providerRequestId === 'string') run.providerRequestId = result.providerRequestId;
              finish(run);
            }).catch(error => { if (!run.ended) { run.failure = error instanceof Error ? error.message : 'Voice processing failed. Please try again.'; finish(run); } });
        };
        recorder.start(250); run.started = Date.now(); updatePhase('recording');
        report('Listening. Your words will appear when you finish recording.');
        if (endMode === 'auto') startSilenceDetection(run, stream);
        run.maxTimer = setTimeout(() => stop(run,'limit'), 120_000);
        return;
      }
      const endpoint = new URL(data.webSocketUrl);
      if (endpoint.protocol !== 'wss:' || !['api.deepgram.com', 'api.eu.deepgram.com'].includes(endpoint.hostname)) throw new Error('Voice connection could not be verified. Please contact your administrator.');
      // MediaRecorder emits a container: do not declare raw audio encoding or sample rate.
      endpoint.searchParams.delete('encoding'); endpoint.searchParams.delete('sample_rate');
      const socket = new WebSocket(endpoint, ['bearer', data.accessToken]); run.socket = socket;
      run.drainTimer = setTimeout(() => { run.failure = 'Transcription connection timed out. Please try again.'; finish(run); }, 10_000);
      socket.onopen = () => {
        if (run.ended) { socket.close(); return; }
        clearTimeout(run.drainTimer);
        try {
        const recorder = new MediaRecorder(stream, { mimeType }); run.recorder = recorder;
        recorder.ondataavailable = event => {
          if (!run.ended && event.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(event.data);
        };
        recorder.onerror = () => { run.failure = 'Recording stopped unexpectedly. Received final text was preserved; some speech may be missing.'; finish(run); };
        recorder.onstop = () => {
          if (run.ended) return;
          if (socket.readyState !== WebSocket.OPEN) { finish(run); return; }
          socket.send(JSON.stringify({ type: 'CloseStream' }));
          run.drainTimer = setTimeout(() => { run.failure ??= 'The stream did not finish in time. Received final text was preserved; check for missing words.'; finish(run); }, 4000);
        };
        recorder.start(250); run.started = Date.now(); updatePhase('recording');
        run.maxTimer = setTimeout(() => stop(run,'limit'), 120_000);
        } catch {
          run.failure = 'Audio recording could not start. Please reopen the app in Safari or Chrome.';
          finish(run);
        }
      };
      socket.onmessage = event => {
        if (run.ended || typeof event.data !== 'string') return;
        let data: { type?: string; is_final?: boolean; speech_final?: boolean; start?: number; duration?: number;
          channel?: { alternatives?: { transcript?: string }[] }; metadata?: { request_id?: string }; request_id?: string };
        try { data = JSON.parse(event.data); } catch { return; }
        const requestId = data.metadata?.request_id || data.request_id;
        if (typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) run.providerRequestId = requestId;
        if (data.type === 'Results') {
          const text = data.channel?.alternatives?.[0]?.transcript;
          if (typeof text !== 'string') return;
          if (data.is_final && text.trim()) run.final.set(`${data.start ?? 0}:${data.duration ?? 0}`, text.trim());
          updatePreview([...run.final.values(), ...(!data.is_final ? [text] : [])].join(' '));
          if (endMode === 'auto' && data.speech_final && run.final.size > 0) stop(run,'pause');
        }
        if (data.type === 'UtteranceEnd' && endMode === 'auto' && run.final.size > 0) stop(run,'pause');
        if (data.type === 'Error') { run.failure = 'Transcription stopped. Received final text was preserved; some speech may be missing.'; finish(run); }
      };
      socket.onerror = () => { run.failure = 'The transcription connection failed. Received final text was preserved; some speech may be missing.'; finish(run); };
      socket.onclose = event => {
        if (!run.ended) {
          if (!run.stopping || event.code !== 1000) run.failure = 'The transcription connection closed. Received final text was preserved; some speech may be missing.';
          finish(run);
        }
      };
    } catch (error) {
      run.failure = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Allow microphone access in browser settings, then tap the microphone again. On iPhone, use Safari’s website settings.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'No microphone was found. Connect a microphone and try again.'
        : error instanceof DOMException && error.name === 'NotReadableError' ? 'Your microphone is being used by another app. Close it and try again.'
        : error instanceof Error ? error.message : 'Voice could not connect. Please try again.';
      finish(run);
    }
  }

  const active = phase === 'recording';
  const label = active ? 'Tap to finish' : phase === 'starting' ? 'Connecting microphone' : phase === 'stopping' ? 'Processing your voice' : 'Tap to speak';
  return <div className={`speech-capture speech-${phase} ${compact ? 'speech-compact' : ''}`}>
    <div className="speech-orbit" aria-hidden="true"><span/><span/><span/></div>
    <button type="button" className={`speech-mic ${active ? 'is-listening' : ''}`}
      aria-label={active ? 'Stop recording and send voice message' : label} aria-pressed={active}
      disabled={mode === 'demo' || (phase === 'idle' && disabled) || phase === 'starting' || phase === 'stopping'}
      onClick={() => active && current.current ? stop(current.current) : void start()}>
      {active ? <Square size={30} fill="currentColor"/> : phase !== 'idle' ? <LoaderCircle className="spin" size={36}/> : <Mic size={38} strokeWidth={1.7}/>}
    </button>
    <p className="speech-label">{label}</p>
    <div className={`speech-wave ${active ? 'is-active' : ''}`} aria-hidden="true">{Array.from({length: 9}, (_, i) => <span key={i} style={{ animationDelay: `${i * 90}ms` }}/>)}</div>
    {mode === 'demo' && !compact && <p className="speech-status" role="status">Voice service is not configured. An administrator must add the Deepgram key to enable the microphone.</p>}
    {active && !compact && <p className="speech-status" role="status">{endMode === 'auto' ? 'Listening… I’ll finish after a pause.' : 'Listening… Tap again when you finish.'} Maximum 2 minutes.</p>}
    {preview && !compact && <p className="speech-transcript" aria-live="polite">{preview}</p>}
    {message && !compact && <p className="speech-status" role="status">{message}</p>}
  </div>;
}
