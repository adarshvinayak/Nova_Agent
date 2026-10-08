import {test,expect} from '@playwright/test';

test('mobile voice request sends and confirms on the start page',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/config',route=>route.fulfill({json:{speechAvailable:true}}));
 await page.route('**/api/speech/token',route=>route.fulfill({json:{speechSessionId:'30000000-0000-4000-8000-000000000001',accessToken:'temporary-test-token',webSocketUrl:'wss://api.deepgram.com/v1/listen'}}));
 await page.route('**/api/speech/finish',route=>route.fulfill({json:{ok:true}}));
 const day=new Date(Date.now()+86400000*(800+Math.floor(Math.random()*500))).toISOString().slice(0,10);
 await page.addInitScript(({transcript})=>{
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  class FakeRecorder {
   static isTypeSupported(){return true;}
   state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;
   start(){this.state='recording';}
   stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();}
  }
  const OriginalSocket=window.WebSocket;
  class FakeSocket {
   static OPEN=1;static CLOSING=2;readyState=1;
   onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;
   constructor(url:string,protocols?:string[]){if(!String(url).startsWith('wss://api.deepgram.com/'))return new OriginalSocket(url,protocols) as unknown as FakeSocket;setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'Results',is_final:false,start:0,duration:2,channel:{alternatives:[{transcript:'I need an appointment'}]}})});setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'Results',is_final:true,speech_final:true,start:0,duration:2,channel:{alternatives:[{transcript}]}})}),500);},30);}
   send(data:unknown){if(typeof data==='string'&&data.includes('CloseStream'))setTimeout(()=>{this.readyState=3;this.onclose?.({code:1000});},20);}
   close(){this.readyState=3;}
  }
  Object.defineProperty(window,'MediaRecorder',{value:FakeRecorder});Object.defineProperty(window,'WebSocket',{value:FakeSocket});
 },{transcript:`Book a mobile visit on ${day} at 10:00 am for 30 minutes at Warehouse Voice.`});
 await page.goto('/');await page.getByLabel('Your name',{exact:true}).fill('Mobile voice tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop recording and send voice message',exact:true})).toBeEnabled();
 await expect(page.getByLabel('Live transcription')).toContainText('I need an appointment');
 await expect(page.getByLabel('Live transcription')).toContainText('Warehouse Voice');
 await expect(page.getByRole('button',{name:'Stop recording and send voice message',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Stop recording and send voice message',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm appointment',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Your conversation',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Confirm appointment',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Appointment confirmed',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('denied microphone permission shows actionable feedback and retains chat fallback',async({page})=>{
 await page.route('**/api/config',route=>route.fulfill({json:{speechAvailable:true}}));
 await page.addInitScript(()=>{Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{throw new DOMException('Denied','NotAllowedError');}}});});
 await page.goto('/');await page.getByRole('combobox',{name:'User code',exact:true}).selectOption('user2');await page.getByLabel('Your name',{exact:true}).fill('Permission tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByText(/Allow microphone access/)).toBeVisible();
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await expect(page.getByLabel('Prefer to type? Send a message')).toBeEnabled();
});

test('mobile voice works through secure upload when temporary tokens are unavailable',async({page})=>{
 await page.setViewportSize({width:320,height:780});
 const title=`Voice upload note ${Date.now()}`;
 const captures:{clientCaptureId:string;source:string}[]=[];
 await page.route('**/api/captures',async route=>{captures.push(route.request().postDataJSON());if(captures.length===1)await route.fulfill({status:503,json:{error:{message:'Temporary request failure'}}});else await route.continue();});
 await page.route('**/api/config',route=>route.fulfill({json:{speechAvailable:true}}));
 await page.route('**/api/speech/token',route=>route.fulfill({json:{speechSessionId:'30000000-0000-4000-8000-000000000001',captureMode:'upload',maxAudioBytes:4000000,maxDurationSeconds:120}}));
 await page.route('**/api/speech/transcribe',route=>route.fulfill({json:{transcript:`Save a note: ${title}`,providerRequestId:'test-request'}}));
 await page.route('**/api/speech/finish',route=>route.fulfill({json:{ok:true}}));
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  class Recorder {
   static isTypeSupported(){return true;}
   state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;
   start(){this.state='recording';}
   stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'],{type:'audio/webm'})});this.onstop?.();}
  }
  Object.defineProperty(window,'MediaRecorder',{value:Recorder});
 });
 await page.goto('/');await page.getByLabel('Your name',{exact:true}).fill('Upload voice tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.getByRole('button',{name:'Tap to speak',exact:true}).click();await page.getByRole('button',{name:'Stop recording and send voice message',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Temporary request failure'})).toBeVisible();
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await expect(page.getByLabel('Prefer to type? Send a message')).toHaveValue(`Save a note: ${title}`);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Confirm note',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 expect(captures).toHaveLength(2);expect(captures[1].clientCaptureId).toBe(captures[0].clientCaptureId);expect(captures[1].source).toBe('browser_voice');
 await expect(page.getByRole('log',{name:'Conversation'})).toContainText(title);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
