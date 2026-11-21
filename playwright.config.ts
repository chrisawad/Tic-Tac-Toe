import { defineConfig } from '@playwright/test';

const local = 'http://127.0.0.1:4317' + (process.env.BASE_PATH || '/');
const live = process.env.PLAY_URL;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  timeout: 35_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: live || local,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: live ? undefined : {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4317 --strictPort',
    url: local,
    reuseExistingServer: !process.env.CI,
  },
});
