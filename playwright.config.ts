import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,
 use:{baseURL:process.env.E2E_BASE_URL??'http://localhost:3000',trace:'retain-on-failure',launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:undefined,...devices['Desktop Chrome']},
 reporter:[['list']],outputDir:'test-results',
});
