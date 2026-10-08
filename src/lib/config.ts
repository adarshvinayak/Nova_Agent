import 'server-only';
export function config() {
  const mode = process.env.APP_MODE ?? 'live';
  if (mode !== 'demo' && mode !== 'live') throw new Error('APP_MODE must be demo or live');
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const origin = new URL(process.env.APP_ORIGIN ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:3000')).origin;
  if (process.env.VERCEL === '1' && (mode !== 'live' || new URL(origin).protocol !== 'https:' || ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))) {
    throw new Error('Vercel requires live mode and an HTTPS application origin');
  }
  if (mode === 'demo' && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)) {
    throw new Error('Demo mode is restricted to a local origin. Configure live services for deployment.');
  }
  return { mode, origin, timeZone: 'Asia/Dubai', databaseUrl: process.env.DATABASE_URL } as const;
}
export function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Server configuration missing: ${name}`);
  return value;
}
