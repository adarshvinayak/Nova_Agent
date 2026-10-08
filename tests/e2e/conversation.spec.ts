import {test,expect,type Page} from '@playwright/test';
async function signIn(page:Page){await page.goto('/');await page.getByLabel('Your name',{exact:true}).fill('Conversation tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('button',{name:'Tap to speak',exact:true})).toBeVisible();}
async function streaming(page:Page,transcript:string){
 await page.route('**/api/speech/token',route=>route.fulfill({json:{speechSessionId:'30000000-0000-4000-8000-000000000001',accessToken:'temporary-test-token',webSocketUrl:'wss://api.deepgram.com/v1/listen'}}));
 await page.route('**/api/speech/finish',route=>route.fulfill({json:{ok:true}}));
 await page.addInitScript(({transcript})=>{
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  class Recorder {
   static isTypeSupported(){return true;}
   state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;
   start(){this.state='recording';}
   stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();}
  }
  const OriginalSocket=window.WebSocket;
  class Socket {
   static OPEN=1;static CLOSING=2;readyState=1;
   onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;
   constructor(url:string,protocols?:string[]){if(!String(url).startsWith('wss://api.deepgram.com/'))return new OriginalSocket(url,protocols) as unknown as Socket;
    setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'UtteranceEnd'})});this.onmessage?.({data:JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'Save a note'}]}})});},50);
    setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'Results',is_final:true,speech_final:true,start:0,duration:2,channel:{alternatives:[{transcript}]}})}),700);
   }
   send(value:unknown){if(typeof value==='string'&&value.includes('CloseStream'))setTimeout(()=>{this.readyState=3;this.onclose?.({code:1000});},30);}
   close(){this.readyState=3;}
  }
  Object.defineProperty(window,'MediaRecorder',{value:Recorder});Object.defineProperty(window,'WebSocket',{value:Socket});
 },{transcript});
}

test('automatic mode shows interim words and sends only after final speech',async({page})=>{
 await page.setViewportSize({width:390,height:844});await streaming(page,'Save a note: Automatic voice note');await signIn(page);
 await page.getByRole('switch',{name:'Automatically send after a pause'}).check();await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByLabel('Live transcription')).toContainText('Save a note');
 await expect(page.getByRole('switch',{name:'Automatically send after a pause'})).toBeDisabled();
 await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 await expect(page.getByRole('log',{name:'Conversation'})).toContainText('Automatic voice note');
 await page.reload();await expect(page.getByRole('switch',{name:'Automatically send after a pause'})).toBeChecked();
});

test('manual mode retains endpointed speech until the microphone is tapped',async({page})=>{
 await streaming(page,'Save a note: Manual voice note');await signIn(page);await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByLabel('Live transcription')).toContainText('Manual voice note');
 await expect(page.getByRole('button',{name:'Stop recording and send voice message',exact:true})).toBeEnabled();
 await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Stop recording and send voice message',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
});

test('only the conversation scrolls while bottom controls and approvals stay in the same section',async({page})=>{
 await page.setViewportSize({width:320,height:780});await signIn(page);
 const input=page.getByLabel('Prefer to type? Send a message');await input.fill('Save a note: '+('A detailed message for the scroll test. '.repeat(100)));await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 const first=await page.locator('.agent-dock').boundingBox();
 const measure=await page.evaluate(()=>{const thread=document.querySelector('.agent-thread')!;return {pageScroll:document.documentElement.scrollHeight>innerHeight+1,horizontal:document.documentElement.scrollWidth>innerWidth,threadScroll:thread.scrollHeight>thread.clientHeight,inside:!!thread.querySelector('.outcome-card')};});
 expect(measure).toEqual({pageScroll:false,horizontal:false,threadScroll:true,inside:true});
 await page.getByRole('log',{name:'Conversation'}).evaluate(element=>{element.scrollTop=0;});expect(await page.locator('.agent-dock').boundingBox()).toEqual(first);
 await page.setViewportSize({width:320,height:450});await expect(page.getByRole('button',{name:'Start a new request',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1)).toBe(true);
});
