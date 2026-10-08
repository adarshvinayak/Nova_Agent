'use client';
import {useState} from 'react';
import {ShieldCheck,ChevronDown} from 'lucide-react';
import styles from './AuditLogList.module.css';
type Row=Record<string,unknown>;
const text=(value:unknown)=>typeof value==='string'?value:'';
const object=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const label=(value:string)=>value.replace(/^va_/,'').replaceAll('_',' ').replaceAll('.',' · ');
function Details({value}:{value:unknown}){
 if(value===null||value===undefined)return <span className={styles.muted}>None</span>;
 if(typeof value!=='object')return <span>{String(value)}</span>;
 return <dl className={styles.fields}>{Object.entries(object(value)).map(([key,v])=><div key={key}><dt>{label(key)}</dt><dd>{typeof v==='object'?<pre>{JSON.stringify(v,null,2)}</pre>:String(v??'None')}</dd></div>)}</dl>;
}
export function AuditLogList({logs,nextCursor,onLoadMore,busy}:{logs:Row[];nextCursor:string|null;onLoadMore:(cursor:string)=>Promise<void>;busy:boolean}){
 const [expanded,setExpanded]=useState<string|null>(null);
 return <section className={styles.list} aria-label="Detailed audit records">
 <p className={styles.notice}>Text and detail snapshots expire after 30 days. Operational history is retained for 90 days, with booking identifiers preserved when needed. Times are shown in UAE time.</p>
 {logs.map(log=>{const id=text(log.id),detail=object(log.detail),content=object(log.content),message=text(content.text),open=expanded===id;return <article key={id} className={styles.record}>
 <button className={styles.summary} aria-expanded={open} onClick={()=>setExpanded(open?null:id)}><span><strong>{label(text(log.eventType))}</strong><small><span className="code-chip">{text(log.userCode)||'system'}</span> {text(log.alias)} · {text(detail.source)||text(detail.status)||text(detail.operation)}</small><time dateTime={text(log.createdAt)}>{new Date(text(log.createdAt)).toLocaleString('en-GB',{timeZone:'Asia/Dubai',dateStyle:'medium',timeStyle:'medium'})}</time>{message&&<span className={styles.preview}>{message}</span>}</span><ChevronDown size={18} className={open?styles.up:''}/></button>
 {open&&<div className={styles.detail}>{message&&<blockquote>{message}</blockquote>}{log.contentRedactedAt?<p className={styles.muted}>Conversation text expired under the retention policy.</p>:<>{content.confirmationSnapshot!==undefined&&<section><h3>Confirmed appointment</h3><Details value={content.confirmationSnapshot}/></section>}{content.before!==undefined&&<section><h3>Before action</h3><Details value={content.before}/></section>}{content.after!==undefined&&<section><h3>After action</h3><Details value={content.after}/></section>}</>}<section><h3>Action metadata</h3><Details value={{...detail,recordId:log.id,subjectId:log.subjectId,sessionId:log.sessionId??detail.sessionId}}/></section></div>}
 </article>;})}
 {!logs.length&&<div className="empty-state"><ShieldCheck size={28}/><p>No audit records yet.</p></div>}
 {nextCursor&&<button className="secondary" disabled={busy} onClick={()=>void onLoadMore(nextCursor)}>{busy?'Loading records…':'Load older records'}</button>}
 </section>;
}
