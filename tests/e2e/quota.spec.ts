import type {Page} from '@playwright/test';
import {test,expect,adminCode} from './fixtures';
async function signIn(page:Page,userCode='user1'){await page.goto('/');await page.getByRole('combobox',{name:'User code',exact:true}).selectOption(userCode);await page.getByLabel('Your name',{exact:true}).fill('Quota tester');await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('button',{name:'Tap to speak',exact:true})).toBeVisible();await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();}
async function send(page:Page,text:string){await page.getByLabel('Prefer to type? Send a message').fill(text);await page.getByRole('button',{name:'Send message',exact:true}).click();}
async function nextChat(page:Page){await page.getByRole('button',{name:'Start a new request',exact:true}).click();await page.getByRole('button',{name:'Start new chat',exact:true}).click();await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();}

test('three full actions block chat, allow dashboard and can be reset live from HQ',async({page,browser})=>{
 await page.setViewportSize({width:390,height:844});await signIn(page,'user2');
 for(let i=0;i<3;i++){
  await send(page,`Save a note: Quota note ${Date.now()} ${i}`);await page.getByRole('button',{name:'Confirm note',exact:true}).click();await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
  if(i<2)await nextChat(page);
 }
 await expect(page.getByRole('alert').filter({hasText:'Request limit reached. Contact your admin.'})).toBeVisible({timeout:10000});
 await expect(page.getByRole('button',{name:'Start a new request',exact:true})).toBeDisabled();await expect(page.getByLabel('Prefer to type? Send a message')).toBeDisabled();await expect(page.locator('.speech-mic')).toBeDisabled();
 await page.screenshot({path:'artifacts/quota-ui/mobile-limit.png'});
 const blocked=await page.request.post('/api/captures',{headers:{Origin:new URL(page.url()).origin},data:{text:'Save a note: Must be blocked',source:'typed',clientCaptureId:crypto.randomUUID()}});expect(blocked.status()).toBe(429);
 const adminContext=await browser.newContext(),admin=await adminContext.newPage();await admin.setViewportSize({width:320,height:780});await admin.goto('/');await admin.getByRole('button',{name:'Admin',exact:true}).click();await admin.getByLabel('Your name',{exact:true}).fill('HQ administrator');await admin.getByLabel('Admin code',{exact:true}).fill(adminCode());await admin.getByRole('button',{name:'Open workspace',exact:true}).click();await admin.getByRole('button',{name:'Dashboard',exact:true}).click();await admin.getByRole('combobox',{name:'Dashboard section'}).selectOption('hq');
 const card=admin.locator('.hq-user').filter({has:admin.getByRole('heading',{name:'user2',exact:true})});await expect(card).toContainText('3 / 3');await expect(card).toContainText('Limit reached');
 await admin.screenshot({path:'artifacts/quota-ui/mobile-hq.png',fullPage:true});
 expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();await expect(page.getByRole('heading',{name:'My activity',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Dashboard section'}).selectOption('tasks');await expect(page.getByRole('button',{name:'Add task',exact:true})).toBeDisabled();
 await admin.getByRole('button',{name:'Reset requests for user2',exact:true}).click();await expect(card).toContainText('0 / 3');await expect(card).toContainText('3 remaining');
 await page.getByRole('combobox',{name:'Dashboard section'}).selectOption('capture');await expect(page.getByRole('button',{name:'Start a new request',exact:true})).toBeEnabled({timeout:10000});await nextChat(page);await send(page,'Save a note: After admin reset');await expect(page.getByRole('button',{name:'Confirm note',exact:true})).toBeEnabled();
 await adminContext.close();
});

test('follow-up corrections stay in one action and cancellation ends the request gracefully',async({page})=>{
 await signIn(page,'user2');await send(page,'Book an appointment');await expect(page.getByRole('log',{name:'Conversation'})).toContainText('What');
 await send(page,'Client meeting');await expect(page.getByRole('log',{name:'Conversation'})).toContainText('Client meeting');
 let response=await page.request.get('/api/actions');let status=await response.json();let quota=status.quota??status;expect(quota.used).toBe(0);expect(quota.active).toBe(1);
 await send(page,'Cancel this request');await expect(page.getByRole('log',{name:'Conversation'})).toContainText(/cancelled/i);await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 response=await page.request.get('/api/actions');status=await response.json();quota=status.quota??status;expect(quota.used).toBe(1);expect(quota.active).toBe(0);
 await nextChat(page);await send(page,'Tell me a joke');await expect(page.getByRole('button',{name:'Complete request',exact:true})).toBeVisible();await page.getByRole('button',{name:'Complete request',exact:true}).click();await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
});
