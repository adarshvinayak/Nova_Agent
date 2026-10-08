'use client';

import { useEffect, useRef, useState } from 'react';

type Props = { onTranscript: (text: string) => void; disabled?: boolean; mode: 'demo' | 'live'; onRecordingChange?: (active: boolean) => void };
type Phase = 'idle' | 'starting' | 'recording' | 'stopping';
type Run = { stream: MediaStream | null; socket: WebSocket | null; recorder: MediaRecorder | null;
  sessionId: string | null; started: number; final: Map<string, string>; providerRequestId?: string;
  ended: boolean; stopping: boolean; failure: string | null; maxTimer?: ReturnType<typeof setTimeout>; drainTimer?: ReturnType<typeof setTimeout> };

export function SpeechCapture({ onTranscript, disabled = false, mode, onRecordingChange }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');
  const current = useRef<Run | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onTranscript, onRecordingChange });
  callbacks.current = { onTranscript, onRecordingChange };

  function finish(run: Run, abandoned = false) {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.maxTimer); clearTimeout(run.drainTimer);
    if (run.recorder?.state === 'recording') run.recorder.stop();
    run.stream?.getTracks().forEach(track => track.stop());
    if (run.socket && run.socket.readyState < WebSocket.CLOSING) run.socket.close();
    const text = [...run.final.values()].join(' ').trim();
    if (run.sessionId) {
      void fetch('/api/speech/finish', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speechSessionId: run.sessionId,
          durationSeconds: run.started ? Math.min(120, Math.max(0, (Date.now() - run.started) / 1000)) : 0,
          status: abandoned ? 'abandoned' : run.failure ? 'failed' : 'finished', providerRequestId: run.providerRequestId }) }).catch(() => undefined);
    }
    if (current.current === run) current.current = null;
    if (mounted.current && !abandoned) {
      setPhase('idle'); setPreview('');
      if (text) callbacks.current.onTranscript(text);
      callbacks.current.onRecordingChange?.(false);
      setMessage(run.failure ?? (text ? 'Transcript added below. Review and edit it before sending.' : 'No speech was received. Try again or type your capture.'));
    }
  }

  function stop(run: Run) {
    if (run.ended || run.stopping) return;
    run.stopping = true; clearTimeout(run.maxTimer);
    if (mounted.current) setPhase('stopping');
    // onstop follows the final dataavailable event, preserving recorder chunk order.
    if (run.recorder?.state === 'recording') run.recorder.stop();
    else finish(run);
    run.stream?.getTracks().forEach(track => track.stop());
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
    current.current = run; setPhase('starting'); setMessage(''); setPreview(''); callbacks.current.onRecordingChange?.(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot stream microphone audio. Please type your capture.');
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser has no supported recording format. Please type your capture.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run.ended) { stream.getTracks().forEach(track => track.stop()); return; }
      run.stream = stream;
      const response = await fetch('/api/speech/token', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Transcription is unavailable. Please type your capture.');
      if (typeof data.speechSessionId !== 'string' || typeof data.accessToken !== 'string' || typeof data.webSocketUrl !== 'string') throw new Error('Transcription could not connect. Please try again.');
      run.sessionId = data.speechSessionId;
      if (run.ended) {
        void fetch('/api/speech/finish', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speechSessionId: run.sessionId, durationSeconds: 0, status: 'abandoned' }) }).catch(() => undefined);
        return;
      }
      const endpoint = new URL(data.webSocketUrl);
      if (endpoint.protocol !== 'wss:' || !['api.deepgram.com', 'api.eu.deepgram.com'].includes(endpoint.hostname)) throw new Error('Unexpected transcription destination. Please type your capture.');
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
        recorder.start(250); run.started = Date.now(); setPhase('recording');
        run.maxTimer = setTimeout(() => stop(run), 120_000);
        } catch {
          run.failure = 'This browser could not start its audio encoder. Please type your capture.';
          finish(run);
        }
      };
      socket.onmessage = event => {
        if (run.ended || typeof event.data !== 'string') return;
        let data: { type?: string; is_final?: boolean; start?: number; duration?: number;
          channel?: { alternatives?: { transcript?: string }[] }; metadata?: { request_id?: string }; request_id?: string };
        try { data = JSON.parse(event.data); } catch { return; }
        const requestId = data.metadata?.request_id || data.request_id;
        if (typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) run.providerRequestId = requestId;
        if (data.type === 'Results') {
          const text = data.channel?.alternatives?.[0]?.transcript;
          if (typeof text !== 'string') return;
          if (data.is_final && text.trim()) run.final.set(`${data.start ?? 0}:${data.duration ?? 0}`, text.trim());
          setPreview([...run.final.values(), ...(!data.is_final ? [text] : [])].join(' '));
        }
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
        ? 'Microphone access was denied. Enable it in browser settings or type your capture.'
        : error instanceof Error ? error.message : 'Could not start transcription. Please type your capture.';
      finish(run);
    }
  }

  return <div className="speech-capture">
    <button type="button" className="secondary" disabled={mode === 'demo' || (phase === 'idle' && disabled) || phase === 'starting' || phase === 'stopping'}
      onClick={() => phase === 'recording' && current.current ? stop(current.current) : void start()}>
      {phase === 'recording' ? 'Stop recording' : phase === 'starting' ? 'Connecting microphone…' : phase === 'stopping' ? 'Finishing transcript…' : 'Use microphone'}
    </button>
    {mode === 'demo' && <p className="muted">Microphone transcription becomes available when Deepgram is connected. Type a capture in this local demo.</p>}
    {phase === 'recording' && <p role="status">Recording. Stops automatically after two minutes.</p>}
    {preview && <p aria-live="polite">{preview}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
