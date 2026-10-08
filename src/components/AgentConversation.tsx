'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AudioLines, Bot, CalendarDays, CheckCircle2, FileText, LoaderCircle, Mic, Plus, User, Volume2, VolumeX, X } from 'lucide-react';
import type { SessionView } from '@/lib/domain';
import { SpeechCapture, type SpeechPhase } from './SpeechCapture';

type Props = {session:SessionView|null;busy:boolean;locked:boolean;speechAvailable:boolean;
 value:string;onChange:(value:string)=>void;onSend:(text:string,source?:'typed'|'browser_voice')=>void;
 onRecordingChange:(active:boolean)=>void;onNew:()=>void;children?:ReactNode;error?:string;onDismissError?:()=>void};

export function AgentConversation({session,busy,locked,speechAvailable,value,onChange,onSend,onRecordingChange,onNew,children,error,onDismissError}:Props) {
 const [phase,setPhase]=useState<SpeechPhase>('idle');
 const [endMode,setEndMode]=useState<'manual'|'auto'>('manual');
 const [preview,setPreview]=useState(''),[speechStatus,setSpeechStatus]=useState(''),[pending,setPending]=useState<string|null>(null);
 const [voiceReplies,setVoiceReplies]=useState(true),[answering,setAnswering]=useState(false);
 const [voiceReady,setVoiceReady]=useState(false);
 const spoken=useRef(new Set<string>()),thread=useRef<HTMLDivElement>(null);
 const lastAssistant=session?.turns.filter(turn=>turn.speaker==='assistant').at(-1);
 const isRecording=phase!=='idle';
 useEffect(()=>{setVoiceReady('speechSynthesis' in window);try{const saved=localStorage.getItem('nova.endMode');if(saved==='auto'||saved==='manual')setEndMode(saved);}catch{}return()=>{window.speechSynthesis?.cancel();};},[]);
 useEffect(()=>{if(!busy)setPending(null);},[busy]);
 useEffect(()=>{setSpeechStatus('');setPreview('');},[session?.id]);
 useEffect(()=>{
  if (!voiceReplies || !voiceReady || !lastAssistant?.body || spoken.current.has(lastAssistant.id)) return;
  spoken.current.add(lastAssistant.id);window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(lastAssistant.body);utterance.lang='en-GB';utterance.rate=1;
  utterance.onstart=()=>setAnswering(true);utterance.onend=utterance.onerror=()=>setAnswering(false);
  window.speechSynthesis.speak(utterance);
  return()=>{window.speechSynthesis.cancel();setAnswering(false);};
 },[lastAssistant?.id,lastAssistant?.body,voiceReplies,voiceReady]);
 // Scroll the message pane only. The page and bottom controls never move.
 useEffect(()=>{const pane=thread.current;if(pane)pane.scrollTo({top:pane.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});},[session?.version,busy,preview,speechStatus,error,pending]);
 const send=(message:string,source:'typed'|'browser_voice'='typed')=>{if(!message.trim()||busy)return;setPending(message.trim());onSend(message,source);};
 const status=phase==='starting'?'Connecting microphone':phase==='recording'?(endMode==='auto'?'Listening · pause to send':'Listening · tap to send'):phase==='stopping'?'Finishing transcript':busy?'Processing your request':answering?'Agent is answering':locked?(session?.state==='confirming'||session?.state==='booking_unknown'?'Checking booking status':'Request complete'):session?.state==='ready'?'Review and confirm in the conversation':session?'Ready for your reply':'Ready when you are';
 return <section className="agent-page" aria-label="Voice assistant">
  <header className="agent-header"><div className="agent-identity"><h1 className="sr-only">{session?'Your conversation':'How can I help?'}</h1></div><div className={`agent-status ${busy?'processing':answering?'answering':phase}`} role="status" title={status}><span className="sr-only">{status}</span>{busy||phase==='starting'||phase==='stopping'?<LoaderCircle className="spin" size={20}/>:phase==='recording'||answering?<AudioLines className="status-wave" size={20}/>:locked?<CheckCircle2 size={20}/>:<Mic size={20}/>}</div><button className="icon-button" aria-label={voiceReplies?'Mute spoken replies':'Enable spoken replies'} aria-pressed={voiceReplies} disabled={!voiceReady} onClick={()=>{window.speechSynthesis?.cancel();setAnswering(false);setVoiceReplies(!voiceReplies);}}>{voiceReplies?<Volume2 size={21}/>:<VolumeX size={21}/>}</button></header>
  <div className="agent-body">
   <div className="agent-thread" ref={thread} role="log" aria-label="Conversation" aria-live="polite" tabIndex={0}>
    {!session&&!busy&&!preview&&phase==='idle'&&<div className="agent-empty"><div className="agent-empty-symbol" aria-hidden="true"><AudioLines size={42} strokeWidth={1.3}/></div><div className="agent-suggestions"><button aria-label="Book an appointment" disabled={busy||isRecording} onClick={()=>onChange('Book a site inspection tomorrow at 10 am for 30 minutes at Warehouse 2.')}><CalendarDays size={18}/>Book</button><button aria-label="Save a note" disabled={busy||isRecording} onClick={()=>onChange('Save a note: Ask the supplier about the updated delivery schedule.')}><FileText size={18}/>Note</button></div></div>}
    {session&&(session.contentExpired?<div className="agent-message assistant"><p>This conversation’s content has expired.</p></div>:session.turns.map(turn=><div className={`agent-message ${turn.speaker}`} key={turn.id}><span className="message-author"><span className="sr-only">{turn.speaker==='assistant'?'Nova Agent':'You'}</span>{turn.speaker==='assistant'?<Bot size={15}/>:<User size={15}/>}</span><p>{turn.body??'Content expired'}</p></div>))}
    {preview&&<div className="agent-message user live-transcript" aria-label="Live transcription"><span className="message-author"><AudioLines size={15}/><span className="sr-only">You · speaking</span></span><p>{preview}<span className="transcript-caret" aria-hidden="true"/></p></div>}
    {pending&&busy&&<div className="agent-message user"><span className="message-author"><User size={15}/><span className="sr-only">You · sending</span></span><p>{pending}</p></div>}
    {busy&&<div className="agent-message assistant"><span className="message-author"><Bot size={15}/><span className="sr-only">Nova Agent</span></span><span className="agent-loading-dots" aria-label="Processing"><i/><i/><i/></span></div>}
    {!speechAvailable&&<div className="agent-message assistant" role="status"><p>Voice unavailable. Type a message below.</p></div>}
    {speechStatus&&speechStatus!=='Voice message ready.'&&<div className="agent-message assistant speech-feedback" role="status"><p>{speechStatus}</p></div>}
    {error&&<div className="agent-message assistant error-box" role="alert"><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={onDismissError}><X size={17}/></button></div>}
    {children&&<div className="agent-inline-interaction">{children}</div>}
   </div>
   <div className="agent-dock">
    <div className="agent-end-mode"><label className="end-mode-toggle" title={endMode==='auto'?'Send after a pause':'Tap microphone to finish'}><input type="checkbox" role="switch" aria-label="Automatically send after a pause" checked={endMode==='auto'} disabled={busy||isRecording} onChange={event=>{const next=event.target.checked?'auto':'manual';setEndMode(next);try{localStorage.setItem('nova.endMode',next);}catch{}}}/><span>{endMode==='auto'?'Auto':'Manual'}</span></label></div>
    <div className="agent-dock-inputs"><SpeechCapture compact endMode={endMode} mode={speechAvailable?'live':'demo'} disabled={busy||locked} onPreview={setPreview} onStatus={setSpeechStatus} onPhaseChange={next=>{setPhase(next);if(next==='starting'){window.speechSynthesis?.cancel();setAnswering(false);}}} onRecordingChange={onRecordingChange} onTranscript={(transcript,metadata)=>{if(metadata?.complete&&!value.trim()){onChange(transcript.slice(0,8000));send(transcript.slice(0,8000),'browser_voice');}else onChange([value.trim(),transcript.trim()].filter(Boolean).join(' ').slice(0,8000));}}/>
     <form className="agent-composer" onSubmit={event=>{event.preventDefault();if(value.trim()&&!busy&&!isRecording&&!locked)send(value);}}><label className="sr-only" htmlFor="agent-text">Prefer to type? Send a message</label><div className="agent-input-row"><textarea id="agent-text" rows={1} maxLength={8000} value={value} onChange={event=>onChange(event.target.value)} disabled={busy||isRecording||locked} placeholder={locked?'Start a new request to continue':session?'Add a detail or correction…':'Type your request…'}/><button className="primary" aria-label="Send message" disabled={busy||isRecording||locked||!value.trim()}><ArrowUp size={21}/></button></div></form>
    </div>
    {locked?<div className="agent-controls"><button className="icon-button" aria-label="Start a new request" title="New request" disabled={busy} onClick={onNew}><Plus size={22}/></button></div>:null}
   </div>
  </div>
 </section>;
}
