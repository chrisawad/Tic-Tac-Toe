import { defineConfig } from '@playwright/test';

const local = 'http://127.0.0.1:4317' + (process.env.BASE_PATH || '/');
const live = process.env.PLAY_URL;
const isolated = !live && !process.env.LIVE_ROOM_TEST;
const vite = 'node node_modules/vite/bin/vite.js';

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
    trace: live || process.env.LIVE_ROOM_TEST ? 'off' : 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: live ? undefined : [...(isolated ? [{
    command: 'node node_modules/peer/dist/bin/peerjs.js --port 9117 --host 127.0.0.1',
    url: 'http://127.0.0.1:9117/',
  }] : []), {
    command: (isolated ? vite + ' build --outDir .qa/online && ' : '') +
      vite + ' preview --host 127.0.0.1 --port 4317 --strictPort' + (isolated ? ' --outDir .qa/online' : ''),
    env: isolated ? { VITE_PEER_HOST: '127.0.0.1', VITE_PEER_PORT: '9117', VITE_PEER_SECURE: 'false', VITE_TURN_WORKER_URL: '/test-turn-credentials' } : {},
    timeout: 180_000,
    url: local,
    reuseExistingServer: false,
  }],
});
