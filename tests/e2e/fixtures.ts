import {test as base,expect,type APIRequestContext} from '@playwright/test';
export function adminCode(){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',month:'2-digit',year:'numeric'}).formatToParts(new Date());return parts.find(p=>p.type==='month')!.value+parts.find(p=>p.type==='year')!.value;}
export async function adminApi(context:APIRequestContext,origin:string){const response=await context.post('/api/auth/login',{headers:{Origin:origin},data:{userCode:'admin',name:'Quota test administrator',code:adminCode()}});expect(response.ok()).toBe(true);}
let administrator:APIRequestContext|undefined;
export const test=base.extend<{resetActions:void}>({resetActions:[async({playwright,baseURL},use)=>{
 const origin=new URL(baseURL!).origin;
 if(!administrator){administrator=await playwright.request.newContext({baseURL});await adminApi(administrator,origin);}
 for(const userCode of ['user1','user2']){const reset=await administrator.post('/api/hq',{headers:{Origin:origin},data:{userCode}});expect(reset.ok()).toBe(true);}await use();
},{auto:true}]});
export {expect};
