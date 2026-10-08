import {type Page} from '@playwright/test';
import {test,expect} from './fixtures';
async function signIn(page:Page,userCode='user1'){await page.goto('/');await page.getByRole('combobox',{name:'User code',exact:true}).selectOption(userCode);await page.getByLabel('Your name',{exact:true}).fill('Conversation tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('button',{name:'Tap to speak',exact:true})).toBeVisible();}
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
 await page.setViewportSize({width:390,height:844});await streaming(page,'Save a note: Automatic voice note');await signIn(page,'user2');
 await page.getByRole('switch',{name:'Automatically send after a pause'}).check();await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByLabel('Live transcription')).toContainText('Save a note');
 await expect(page.getByRole('switch',{name:'Automatically send after a pause'})).toBeDisabled();
 await page.getByRole('button',{name:'Confirm note',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 await expect(page.getByRole('log',{name:'Conversation'})).toContainText('Automatic voice note');
 await page.reload();await expect(page.getByRole('switch',{name:'Automatically send after a pause'})).toBeChecked();
});

test('manual mode retains endpointed speech until the microphone is tapped',async({page})=>{
 await streaming(page,'Save a note: Manual voice note');await signIn(page,'user2');await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
 await expect(page.getByLabel('Live transcription')).toContainText('Manual voice note');
 await expect(page.getByRole('button',{name:'Stop recording and send voice message',exact:true})).toBeEnabled();
 await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Stop recording and send voice message',exact:true}).click();await page.getByRole('button',{name:'Confirm note',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
});

test('only the conversation scrolls while bottom controls and approvals stay in the same section',async({page})=>{
 await page.setViewportSize({width:320,height:780});await signIn(page);
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();const input=page.getByLabel('Prefer to type? Send a message');await input.fill('A detailed message for the scroll test. '.repeat(100));await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('log',{name:'Conversation'})).toContainText('What would you like?');await input.fill('Save a note: Short note after a long conversation');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('button',{name:'Confirm note',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 const first=await page.locator('.agent-dock').boundingBox();
 const measure=await page.evaluate(()=>{const thread=document.querySelector('.agent-thread')!;return {pageScroll:document.documentElement.scrollHeight>innerHeight+1,horizontal:document.documentElement.scrollWidth>innerWidth,threadScroll:thread.scrollHeight>thread.clientHeight,inside:!!thread.querySelector('.outcome-card')};});
 expect(measure).toEqual({pageScroll:false,horizontal:false,threadScroll:true,inside:true});
 await page.getByRole('log',{name:'Conversation'}).evaluate(element=>{element.scrollTop=0;});expect(await page.locator('.agent-dock').boundingBox()).toEqual(first);
 await page.setViewportSize({width:320,height:450});await expect(page.getByRole('button',{name:'Start a new request',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1)).toBe(true);
});

test('voice and keyboard slide without losing draft, and new chat requires confirmation',async({page})=>{
 await page.setViewportSize({width:390,height:844});await signIn(page,'user2');
 const composer=page.getByLabel('Prefer to type? Send a message');
 await expect(composer).toBeHidden();await expect(page.getByRole('button',{name:'Start a new request',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await composer.fill('Save a note: Keep this draft');
 await page.getByRole('button',{name:'Switch to voice input',exact:true}).click();await expect(composer).toBeHidden();
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await expect(composer).toHaveValue('Save a note: Keep this draft');
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();await expect(page.getByRole('group',{name:'Confirm new chat'})).toBeVisible();
 await page.getByRole('button',{name:'Keep this chat',exact:true}).click();await expect(composer).toHaveValue('Save a note: Keep this draft');
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();await page.getByRole('button',{name:'Start new chat',exact:true}).click();
 await expect(composer).toBeHidden();await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await expect(composer).toHaveValue('');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('task assignment can be corrected before confirmation and personal tasks are summarized in chat',async({page})=>{
 await page.setViewportSize({width:390,height:844});await signIn(page);
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();
 const input=page.getByLabel('Prefer to type? Send a message'),title=`Assistant assigned task ${Date.now()}`;
 await input.fill(`Create task: ${title} to user2 by 2035-01-01 at 10:00`);await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('log',{name:'Conversation'})).toContainText('Assigned to user2');
 await input.fill('Assign to me');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('log',{name:'Conversation'})).toContainText('Assigned to user1');
 await page.getByRole('button',{name:'Confirm task',exact:true}).click();await expect(page.getByRole('heading',{name:'Task created',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();await page.getByRole('button',{name:'Start new chat',exact:true}).click();
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();await input.fill('My tasks');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.locator('.agenda-chat')).toContainText(title);
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();await page.getByRole('combobox',{name:'Dashboard section'}).selectOption('assigned');
 await expect(page.getByRole('heading',{name:'Assigned tasks',exact:true})).toBeVisible();await expect(page.getByText(title,{exact:true})).toBeVisible();
});
