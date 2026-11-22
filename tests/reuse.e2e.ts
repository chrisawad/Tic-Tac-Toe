import { expect, test } from '@playwright/test';
import { createServer } from 'vite';

test('an independent counter game hosts, joins, exchanges actions, and leaves', async ({ page, browser }) => {
  test.skip(!process.env.LIVE_ROOM_TEST, 'Uses the live signaling service');
  test.setTimeout(60_000);
  const server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    optimizeDeps: { entries: ['tests/fixtures/counter.html'], include: ['peerjs', 'qrcode'] },
    logLevel: 'error',
  });
  const guest = await browser.newPage();
  try {
    await server.listen();
    const url = new URL('tests/fixtures/counter.html', server.resolvedUrls!.local[0]).href;
    await Promise.all([page.goto(url), guest.goto(url)]);
    await page.getByRole('button', { name: 'Host' }).click();
    await expect(page.getByRole('textbox')).toHaveValue(/^[A-Z2-9]{5}$/);
    await guest.getByRole('textbox').fill(await page.getByRole('textbox').inputValue());
    await guest.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('#status')).toHaveText('Amy + Bea, seat 0', { timeout: 42_000 });
    await expect(guest.locator('#status')).toHaveText('Amy + Bea, seat 1');
    await page.getByRole('button', { name: 'Add two' }).click();
    await expect(guest.locator('#total')).toHaveText('2');
    await guest.getByRole('button', { name: 'Add two' }).click();
    await expect(page.locator('#total')).toHaveText('4');
    await page.getByRole('button', { name: 'Leave' }).click();
    await expect(guest.locator('#status')).toContainText('opponent left');
  } finally {
    await guest.close();
    await server.close();
  }
});
