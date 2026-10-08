import 'server-only';
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { requiredSecret } from './config';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function tokenHash(value: string) { return createHmac('sha256', requiredSecret('SHORTCUT_HASH_KEY')).update(value).digest('hex'); }
export function constantEqual(a: string, b: string) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
function encryptionKey() { const key=Buffer.from(requiredSecret('TOKEN_ENCRYPTION_KEY'),'hex'); if(key.length!==32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as hex'); return key; }
export function encrypt(value: string, context: string) {
  const nonce=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',encryptionKey(),nonce); cipher.setAAD(Buffer.from(context));
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [nonce,cipher.getAuthTag(),encrypted].map(v=>v.toString('base64url')).join('.');
}
export function decrypt(value: string, context: string) {
  const [nonce,tag,ciphertext]=value.split('.').map(v=>Buffer.from(v,'base64url'));
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),nonce); decipher.setAAD(Buffer.from(context));decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
}
