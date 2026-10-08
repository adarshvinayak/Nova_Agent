import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import path from 'node:path';
config({ path: '.env.local', quiet: true });
// Unit/integration suites choose providers explicitly; never call paid live APIs from tests.
delete process.env.LANGUAGE_PROVIDER;delete process.env.SPEECH_PROVIDER;delete process.env.PILOT_LOGIN;
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), 'server-only': path.resolve(__dirname, 'tests/server-only.ts') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 15000 }
});
