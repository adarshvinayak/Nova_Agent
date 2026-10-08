import { z } from 'zod';
import { actor } from '@/lib/auth';
import { api,jsonBody,mutationGuard,rateLimit } from '@/lib/http';
import { connectCalendar,connectorInput,disconnectCalendar,listConnectors } from '@/lib/connectors';
import { moduleTransaction } from '@/lib/workspace-modules';
export const dynamic='force-dynamic';
export async function GET(){return api(async()=>{const user=await actor();await moduleTransaction(user,'settings',async()=>{});return {connectors:await listConnectors(user)};});}
export async function POST(request:Request){return api(async()=>{mutationGuard(request);const user=await actor();await moduleTransaction(user,'settings',async()=>{});await rateLimit('connector:'+user.id,5);return connectCalendar(user,connectorInput.parse(await jsonBody(request)));});}
export async function DELETE(request:Request){return api(async()=>{mutationGuard(request);const user=await actor();await moduleTransaction(user,'settings',async()=>{});const input=z.object({provider:z.enum(['google','outlook','icloud','fastmail'])}).strict().parse(await jsonBody(request));return disconnectCalendar(user,input.provider);});}
