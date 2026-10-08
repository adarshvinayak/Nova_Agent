'use client';
import type { ReactNode } from 'react';
export function CaptureComposer({value,onChange,disabled,children}:{value:string;onChange:(value:string)=>void;disabled:boolean;children?:ReactNode}) {
  return <div className="composer"><label htmlFor="capture-text">What would you like to capture?</label><textarea id="capture-text" value={value} onChange={e=>onChange(e.target.value)} disabled={disabled} maxLength={8000} placeholder="Book a site inspection tomorrow at 10 am for 30 minutes at Warehouse 2…" rows={5}/>{children}<div className="composer-hint"><span>Review your words before submitting.</span><span>{value.length.toLocaleString()} / 8,000</span></div></div>;
}
