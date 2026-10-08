import {type Page} from '@playwright/test';
import {test,expect} from './fixtures';
async function signIn(page:Page,worker=1){await page.goto('/');await page.getByRole('combobox',{name:'User code',exact:true}).selectOption(`user${worker}`);await page.getByLabel('Your name',{exact:true}).fill(`Browser worker ${worker}`);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('button',{name:'Tap to speak',exact:true})).toBeVisible();}
test('reviewed note persists through reload and is isolated from the other worker',async({page,browser})=>{
 await signIn(page);const title=`Browser note ${Date.now()}`;
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();
 await page.getByLabel('Prefer to type? Send a message').fill('Save a note: '+title);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Confirm note',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'Dashboard',exact:true}).click();await page.getByRole('button',{name:'My activity',exact:true}).click();await page.getByRole('button',{name:'Notes',exact:true}).click();
 const row=page.getByRole('button').filter({hasText:title});await expect(row).toHaveCount(1);await row.click();
 await expect(page.getByRole('heading',{name:'Note saved',exact:true})).toBeVisible();
 const other=await browser.newContext();const otherPage=await other.newPage();await signIn(otherPage,2);await otherPage.getByRole('button',{name:'Dashboard',exact:true}).click();await otherPage.getByRole('button',{name:'My activity',exact:true}).click();await otherPage.getByRole('button',{name:'Notes',exact:true}).click();await expect(otherPage.getByRole('button').filter({hasText:title})).toHaveCount(0);await other.close();
});
test('appointment requires explicit confirmation and records a successful booking',async({page})=>{
 await signIn(page);
 const day=new Date(Date.now()+86400000*(30+Math.floor(Math.random()*300))).toISOString().slice(0,10);
 await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();
 await page.getByLabel('Prefer to type? Send a message').fill(`Book a site visit on ${day} at 10:00 am for 30 minutes at Warehouse E2E.`);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm appointment',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Appointment confirmed',exact:true})).toHaveCount(0);
 await expect(page.locator('.confirmation-card .compact-details')).not.toHaveAttribute('open','');await page.locator('.confirmation-card summary').click();await expect(page.locator('.confirmation-card .compact-details')).toHaveAttribute('open','');await expect(page.locator('.confirmation-card')).toContainText('Warehouse E2E');
 await page.getByRole('button',{name:'Confirm appointment',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Appointment confirmed',exact:true})).toBeVisible();
 await expect(page.getByText('Saved in the workspace calendar.')).toBeVisible();
});
test('320px browser capture remains usable without horizontal overflow',async({page})=>{
 await page.setViewportSize({width:320,height:780});await signIn(page);
 await expect(page.getByRole('button',{name:'Switch to keyboard input',exact:true})).toBeVisible();await page.getByRole('button',{name:'Switch to keyboard input',exact:true}).click();
 await expect(page.getByLabel('Prefer to type? Send a message')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();await page.getByRole('combobox',{name:'Dashboard section'}).selectOption('dashboard');
 await expect(page.getByRole('heading',{name:'My activity',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('invitation credentials are removed from the URL without automatic acceptance',async({page})=>{
 let accepts=0;await page.route('**/api/auth/accept',route=>{accepts++;return route.fulfill({status:401,json:{error:{message:'Invalid test invitation'}}});});
 await page.goto('/auth/accept#access_token=synthetic-access&refresh_token=synthetic-refresh&type=invite');
 await expect(page).toHaveURL(/\/auth\/accept$/);await expect(page.getByRole('button',{name:'Accept invitation'})).toBeEnabled();expect(accepts).toBe(0);
 await page.getByLabel('New password',{exact:true}).fill('test-password-1234');await page.getByLabel('Confirm password').fill('test-password-1234');
 await page.getByRole('button',{name:'Accept invitation'}).click();await expect(page.getByRole('alert').filter({hasText:'Invalid test invitation'})).toBeVisible();expect(accepts).toBe(1);
});
test('tasks calendar audit and admin permissions operate in the pilot dashboard',async({page,browser})=>{
 await signIn(page);await page.getByRole('button',{name:'Dashboard',exact:true}).click();const suffix=String(Date.now());
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Tasks',exact:true}).click();await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Pilot task '+suffix);await page.getByRole('button',{name:'Create task',exact:true}).click();await expect(page.getByText('Pilot task '+suffix,{exact:true})).toBeVisible();
 await page.getByRole('button',{name:`Mark Pilot task ${suffix} done`}).click();await expect(page.getByRole('button',{name:`Mark Pilot task ${suffix} open`})).toBeVisible();
 await page.getByRole('button',{name:'Calendar',exact:true}).click();await expect(page.getByRole('heading',{name:'Calendar',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add event',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Pilot event '+suffix);
 const future=new Date(Date.now()+86400000*(400+Math.floor(Math.random()*1000))).toISOString().slice(0,10);
 await page.getByLabel('Start · UAE',{exact:true}).fill(future+'T13:00');await page.getByLabel('End · UAE',{exact:true}).fill(future+'T13:30');await page.getByRole('button',{name:'Create event',exact:true}).click();await expect(page.getByRole('heading',{name:'New calendar event'})).toHaveCount(0);
 await page.getByRole('button',{name:'Audit logs',exact:true}).click();await expect(page.getByText('user1',{exact:true}).first()).toBeVisible();await expect(page.getByText('tasks · insert',{exact:true}).first()).toBeVisible();
 const other=await browser.newContext();const user2=await other.newPage();await signIn(user2,2);await user2.getByRole('button',{name:'Dashboard',exact:true}).click();await user2.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Tasks',exact:true}).click();await user2.getByRole('button',{name:'Add task',exact:true}).click();await user2.getByLabel('Title',{exact:true}).fill('Other pilot task '+suffix);await user2.getByRole('button',{name:'Create task',exact:true}).click();await expect(user2.getByText('Other pilot task '+suffix,{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Audit logs',exact:true}).click();await page.getByRole('button',{name:'Refresh section'}).click();await expect(page.getByText('user2',{exact:true})).toHaveCount(0);await expect(page.getByRole('button').filter({hasText:'Browser worker 1'}).first()).toBeVisible();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Admin',exact:true}).click();await page.getByLabel('Your name',{exact:true}).fill('Pilot administrator');
 const code=await page.evaluate(()=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',month:'2-digit',year:'numeric'}).formatToParts(new Date());return parts.find(p=>p.type==='month')!.value+parts.find(p=>p.type==='year')!.value;});
 await page.getByLabel('Admin code',{exact:true}).fill(code);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('button',{name:'Tap to speak',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();await page.getByRole('button',{name:'HQ',exact:true}).click();await expect(page.getByRole('heading',{name:'HQ',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Reset requests for user2',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Audit logs',exact:true}).click();await expect(page.getByText('tasks · insert',{exact:true}).first()).toBeVisible();await expect(page.getByText('user2',{exact:true}).first()).toBeVisible();
 const settings=await page.request.get('/api/settings');expect(settings.ok()).toBe(true);const current=(await settings.json()).users.find((u:{userCode:string})=>u.userCode==='user2');
 const baseURL=new URL(page.url()).origin;
 try{const blocked=await page.request.post('/api/settings',{headers:{Origin:baseURL},data:{action:'permissions',userCode:'user2',permissions:{...current.permissions,tasks:false}}});expect(blocked.ok()).toBe(true);const denied=await user2.request.get('/api/tasks');expect(denied.status()).toBe(403);}finally{const restored=await page.request.post('/api/settings',{headers:{Origin:baseURL},data:{action:'permissions',userCode:'user2',permissions:current.permissions}});expect(restored.ok()).toBe(true);await other.close();}
});
