'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, MessageSquare, Plus, Volume2, VolumeX } from 'lucide-react';
import type { SessionView } from '@/lib/domain';
import { SpeechCapture, type SpeechPhase } from './SpeechCapture';

type Props = {session:SessionView|null;busy:boolean;locked:boolean;speechAvailable:boolean;
 value:string;onChange:(value:string)=>void;onSend:(text:string,source?:'typed'|'browser_voice')=>void;
 onRecordingChange:(active:boolean)=>void;onNew:()=>void;children?:ReactNode};

export function AgentConversation({session,busy,locked,speechAvailable,value,onChange,onSend,onRecordingChange,onNew,children}:Props) {
 const [phase,setPhase]=useState<SpeechPhase>('idle');
 const [voiceReplies,setVoiceReplies]=useState(true),[answering,setAnswering]=useState(false);
 const [voiceReady,setVoiceReady]=useState(false);
 const spoken=useRef(new Set<string>()),threadEnd=useRef<HTMLDivElement>(null);
 const lastAssistant=session?.turns.filter(turn=>turn.speaker==='assistant').at(-1);
 const isRecording=phase!=='idle';
 useEffect(()=>{setVoiceReady('speechSynthesis' in window);return()=>{window.speechSynthesis?.cancel();};},[]);
 useEffect(()=>{
  if (!voiceReplies || !voiceReady || !lastAssistant?.body || spoken.current.has(lastAssistant.id)) return;
  spoken.current.add(lastAssistant.id);
  window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(lastAssistant.body);
  utterance.lang='en-GB';utterance.rate=1;
  utterance.onstart=()=>setAnswering(true);
  utterance.onend=utterance.onerror=()=>setAnswering(false);
  window.speechSynthesis.speak(utterance);
  return()=>{window.speechSynthesis.cancel();setAnswering(false);};
 },[lastAssistant?.id,lastAssistant?.body,voiceReplies,voiceReady]);
 useEffect(()=>{if(session)threadEnd.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'});},[session?.version,busy]);
 const status=phase==='starting'?'Connecting microphone':phase==='recording'?'Listening · tap to finish':phase==='stopping'?'Finishing transcript':busy?'Processing your request':answering?'Agent is answering':locked?(session?.state==='confirming'||session?.state==='booking_unknown'?'Checking booking status':'Request complete'):session?.state==='ready'?'Review and confirm below':session?'Ready for your reply':'Ready when you are';
 return <section className="agent-page" aria-label="Voice assistant">
  <header className="agent-header"><div className="agent-identity"><span className="eyebrow">NOVA AGENT</span><h1>{session?'Your conversation':'How can I help?'}</h1><p>{session?'All the details, in one conversation.':'Tap the microphone to book an appointment or save a note.'}</p></div><button className="icon-button" aria-label={voiceReplies?'Mute spoken replies':'Enable spoken replies'} aria-pressed={voiceReplies} disabled={!voiceReady} onClick={()=>{window.speechSynthesis?.cancel();setAnswering(false);setVoiceReplies(!voiceReplies);}}>{voiceReplies?<Volume2 size={21}/>:<VolumeX size={21}/>}</button></header>
  <div className="agent-body">
   {!locked&&<div className="agent-orb-area"><SpeechCapture mode={speechAvailable?'live':'demo'} disabled={busy} onPhaseChange={next=>{setPhase(next);if(next==='starting'){window.speechSynthesis?.cancel();setAnswering(false);}}} onRecordingChange={onRecordingChange} onTranscript={(transcript,metadata)=>{if(metadata?.complete&&!value.trim()){onChange(transcript.slice(0,8000));onSend(transcript.slice(0,8000),'browser_voice');}else onChange([value.trim(),transcript.trim()].filter(Boolean).join(' ').slice(0,8000));}}/></div>}
   <div className={`agent-status ${busy?'processing':answering?'answering':phase}`} role="status"><span className="agent-state-dot"/>{status}{(busy||answering)&&<span className="agent-loading-dots" aria-hidden="true"><i/><i/><i/></span>}</div>
   {!session&&<div className="agent-suggestions"><button disabled={busy||isRecording} onClick={()=>onChange('Book a site inspection tomorrow at 10 am for 30 minutes at Warehouse 2.')}><span>Book an appointment</span></button><button disabled={busy||isRecording} onClick={()=>onChange('Save a note: Ask the supplier about the updated delivery schedule.')}><span>Save a note</span></button></div>}
   {session&&<div className="agent-thread" role="log" aria-label="Conversation" aria-live="polite">{session.contentExpired?<p>This conversation’s content has expired.</p>:session.turns.map(turn=><div className={`agent-message ${turn.speaker}`} key={turn.id}><span className="message-author">{turn.speaker==='assistant'?'Nova Agent':'You'}</span><p>{turn.body??'Content expired'}</p></div>)}{busy&&<div className="agent-message assistant"><span className="agent-loading-dots" aria-label="Processing"><i/><i/><i/></span></div>}<div ref={threadEnd}/></div>}
   {children}
   {!locked?<form className="agent-composer" onSubmit={event=>{event.preventDefault();if(value.trim()&&!busy&&!isRecording)onSend(value,'typed');}}><label htmlFor="agent-text"><MessageSquare size={16}/>Prefer to type? Send a message</label><div className="agent-input-row"><textarea id="agent-text" rows={2} maxLength={8000} value={value} onChange={event=>onChange(event.target.value)} disabled={busy||isRecording} placeholder={session?'Add a detail or correction…':'Type your request…'}/><button className="primary" aria-label="Send message" disabled={busy||isRecording||!value.trim()}><ArrowUp size={21}/></button></div><small>Voice sends when you stop. Review the details before confirming a booking.</small></form>:<div className="agent-controls"><button className="primary" disabled={busy} onClick={onNew}><Plus size={18}/>Start a new request</button></div>}
  </div>
 </section>;
}
