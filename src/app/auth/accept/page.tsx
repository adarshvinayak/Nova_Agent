'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, AudioLines, CheckCircle2 } from 'lucide-react';
type Invitation={accessToken?:string;refreshToken?:string;tokenHash?:string};
export default function AcceptInvitation(){
 const invite=useRef<Invitation|null>(null),parsed=useRef(false);
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
 useEffect(()=>{
  if(parsed.current)return;parsed.current=true;
  const url=new URL(window.location.href),fragment=new URLSearchParams(url.hash.slice(1));
  const accessToken=fragment.get('access_token'),refreshToken=fragment.get('refresh_token'),tokenHash=url.searchParams.get('token_hash');
  const type=fragment.get('type')??url.searchParams.get('type');
  // Keep credentials in memory only; remove fragment/query before any network request.
  window.history.replaceState(null,'',url.pathname);
  if((type&&type!=='invite')||(!tokenHash&&!(accessToken&&refreshToken))){setError('Open the invitation link sent to your email. If it has expired, ask your workspace owner for a new invitation.');return;}
  invite.current=tokenHash?{tokenHash}:{accessToken:accessToken!,refreshToken:refreshToken!};setReady(true);
 },[]);
 async function submit(event:FormEvent){
  event.preventDefault();setError('');
  if(password.length<12){setError('Use at least 12 characters for your password.');return;}
  if(password!==repeat){setError('The passwords do not match.');return;}
  if(!invite.current){setError('Please reopen your invitation email.');return;}
  setBusy(true);
  try{
   const response=await fetch('/api/auth/accept',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...invite.current,password})});
   const result=await response.json();if(!response.ok)throw new Error(result.error?.message??'Unable to accept the invitation.');
   invite.current=null;setPassword('');setRepeat('');setDone(true);
  }catch(e){setError(e instanceof Error?e.message:'Please try again.');}finally{setBusy(false);}
 }
 return <main className="login-page"><section className="login-story"><div className="brand"><span className="brand-mark"><AudioLines/></span>voice<span className="brand-light">agent</span></div><div><p className="eyebrow">YOUR INVITATION</p><h1>A clearer day<br/>starts here.</h1><p className="story-copy">Capture requests, save useful notes and confirm appointments in your own workspace.</p></div></section><section className="login-card">{done?<><CheckCircle2 size={35}/><h2>Your account is ready</h2><p className="muted">Your password is saved and you’re signed in.</p><a className="primary" href="/">Open workspace<ArrowRight size={18}/></a></>:<><p className="eyebrow">WELCOME TO VOICE AGENT</p><h2>Set your password</h2><p className="muted">Choose a password of at least 12 characters to complete your invitation.</p><form onSubmit={submit}><label>New password<input autoComplete="new-password" type="password" minLength={12} maxLength={256} required value={password} onChange={e=>setPassword(e.target.value)} disabled={!ready||busy}/></label><label>Confirm password<input autoComplete="new-password" type="password" minLength={12} maxLength={256} required value={repeat} onChange={e=>setRepeat(e.target.value)} disabled={!ready||busy}/></label><button className="primary" disabled={!ready||busy}>{busy?'Setting up your account…':'Accept invitation'}<ArrowRight size={18}/></button></form></>}{error&&<div className="error-box" role="alert">{error}</div>}</section></main>;
}
