import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

test('a waiting release prompts automatically, can be deferred, and activates on confirmation', async ({ page, baseURL }) => {
  const upstream = new URL(baseURL!);
  let release = 1;
  // A separate loopback origin lets Chromium install two real versions of the worker.
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      const source = new URL(upstream);
      source.pathname = path;
      const response = await fetch(source);
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (path === upstream.pathname + 'sw.js') {
        const probe = `self.addEventListener('message', e => { if (e.data === 'test-version') e.ports[0].postMessage(${release}); });`;
        res.end(await response.text() + '\n' + probe);
      } else {
        res.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port + upstream.pathname);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    const install = page.locator('#install-dialog');
    const dialog = page.getByRole('dialog', { name: 'Game update ready' });
    await expect(install).toBeVisible();
    await expect(dialog).toBeHidden();
    release++;
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await expect(dialog).toBeVisible();
    await expect(install).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await page.locator('[data-mode="online"]').click();
    await page.getByText('Join a friend', { exact: true }).click();
    await page.locator('#join-code').fill('ABC23');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#update-button').click();
    await Promise.all([page.waitForEvent('domcontentloaded'), dialog.getByRole('button', { name: 'Update now' }).click()]);
    await expect(page.locator('#join-code')).toHaveValue('ABC23');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#update-button')).toBeHidden();
    const version = await page.evaluate(() => new Promise<number>(resolve => {
      const ports = new MessageChannel();
      ports.port1.onmessage = e => { ports.port1.close(); resolve(e.data); };
      navigator.serviceWorker.controller!.postMessage('test-version', [ports.port2]);
    }));
    expect(version).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
