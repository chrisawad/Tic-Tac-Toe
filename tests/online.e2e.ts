import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import type jsQR from 'jsqr';
import { openPublicLink, publicGameUrl, publicInvite } from './invite-links';

const qrDecoder = createRequire(import.meta.url).resolve('jsqr');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const allowed = (page: Page) => page.locator('.cell[aria-disabled="false"]');
const cell = (page: Page, index: number) => page.locator('.cell').nth(index);
const connected = (page: Page) => expect(page.locator('#connection-route')).toHaveText(/^(Direct|Via relay)$/, { timeout: 45_000 });

async function setup(page: Page, name: string, role = 'Host a game') {
  await page.goto('./');
  await button(page, 'Not now').click();
  await page.locator('[data-mode="online"]').click();
  await expect(page.getByRole('radio', { name: 'Host a game' })).toBeChecked();
  await page.getByText(role, { exact: true }).click();
  await page.locator('#name-one').fill(name);
}

async function leaveGame(page: Page) {
  await button(page, 'Leave room').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave room' }).click();
  await expect(page.locator('#setup')).toBeVisible();
}

test('QR invite, scores, alternating X, both seats recover offline and leave', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'Includes phone portrait and landscape in independent browser contexts.');
  test.setTimeout(170_000);
  const host = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  const guest = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let h = await host.newPage(), g = await guest.newPage();
  try {
    await setup(h, 'Nova');
    await button(h, 'Create private room').click();
    await expect(h.locator('#room-qr')).toBeVisible({ timeout: 25_000 });
    const code = await h.locator('#room-code').innerText();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const invite = publicInvite(code);
    await button(h, 'Copy link').click();
    expect(await h.evaluate(() => navigator.clipboard.readText())).toBe(invite);
    await h.evaluate(() => Object.defineProperty(navigator, 'share', {
      value: async (data: ShareData) => { document.documentElement.dataset.shared = data.url; },
    }));
    await button(h, 'Share game').click();
    await expect(h.locator('html')).toHaveAttribute('data-shared', publicGameUrl);
    await button(h, 'Share invite').click();
    await expect(h.locator('html')).toHaveAttribute('data-shared', invite);
    await h.addScriptTag({ path: qrDecoder });
    const scanned = await h.locator('canvas#room-qr').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      return (window as unknown as { jsQR: typeof jsQR }).jsQR(pixels.data, pixels.width, pixels.height)?.data;
    });
    expect(scanned).toBe(invite);
    await openPublicLink(g, scanned!, baseURL!);
    const destination = new URL('#room=' + code, baseURL).href;
    await expect(g).toHaveURL(destination);
    await button(g, 'Not now').click();
    await expect(g.getByRole('radio', { name: 'Join a friend' })).toBeChecked();
    await expect(g.locator('#join-code')).toHaveValue(code);
    await expect(g.getByRole('dialog')).toHaveCount(0);
    await g.locator('#name-one').fill('Emu');
    await g.getByRole('radio', { name: 'violet' }).check({ force: true });
    await button(g, 'Join room').click();
    await Promise.all([connected(h), connected(g)]);
    const colors = (page: Page) => page.locator('.player-card').evaluateAll(cards => cards.map(card => (card as HTMLElement).style.getPropertyValue('--player')));
    const assigned = await colors(h);
    expect(assigned[1]).not.toBe(assigned[0]);
    expect(await colors(g)).toEqual(assigned);
    for (const size of [{ width: 390, height: 844 }, { width: 568, height: 320 }]) {
      await g.setViewportSize(size);
      for (const id of ['#game-back-label', '#board', '#connection-route', '.share-button span'])
        await expect(g.locator(id)).toBeInViewport({ ratio: 1 });
    }
    await button(g, 'Leave room').click();
    await button(g, 'Keep playing').click();
    await cell(h, 0).click();
    await expect(cell(g, 0)).toHaveAttribute('data-mark', 'X');
    for (const [away, opponent] of [[h, g], [g, h]]) {
      const tab = await away.context().newCDPSession(away);
      await away.context().setOffline(true);
      await expect(away.locator('#connection-route')).toHaveText('Reconnecting…');
      await opponent.bringToFront();
      await tab.send('Page.setWebLifecycleState', { state: 'frozen' });
      await expect(opponent.locator('#connection-route')).toHaveText('Reconnecting…', { timeout: 35_000 });
      await expect(allowed(opponent)).toHaveCount(0);
      await tab.send('Page.setWebLifecycleState', { state: 'active' });
      await away.bringToFront();
      await away.context().setOffline(false);
      await Promise.all([connected(away), connected(opponent)]);
      await tab.detach();
    }
    for (const [page, index] of [[g, 3], [h, 1], [g, 4], [h, 2]] as const)
      await cell(page, index).click();
    for (const page of [g, h]) await expect(page.getByRole('dialog', { name: 'Nova wins!' })).toBeVisible();
    await button(g, 'Rematch').click();
    await expect(g.locator('#rematch-button')).toBeDisabled();
    await button(h, 'Rematch').click();
    await expect(g.locator('#turn-status')).toHaveText('Your turn · X');
    await cell(g, 4).click();
    await expect(cell(h, 4)).toHaveAttribute('data-mark', 'X');
    for (const page of [h, g]) await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await Promise.all([h.close(), g.close()]);
    await Promise.all([host.setOffline(true), guest.setOffline(true)]);
    h = await host.newPage();
    g = await guest.newPage();
    // A different invitation must open its own setup. The saved seat is still available.
    const otherCode = code === 'ABC23' ? 'DEF45' : 'ABC23';
    await h.goto(new URL('?room=' + otherCode, baseURL).href);
    await expect(h.locator('#join-code')).toHaveValue(otherCode);
    await button(h, 'Not now').click();
    await button(h, 'Resume room').click();
    await g.goto(destination);
    await g.getByRole('dialog', { name: 'Install Tic Tac Toe' }).getByRole('button', { name: 'Not now' }).click();
    for (const page of [h, g]) {
      await expect(page.locator('#round-counter')).toHaveText('Round 2');
      await expect(cell(page, 4)).toHaveAttribute('data-mark', 'X');
      await expect(page.locator('#score dd')).toHaveText(['1', '0', '0']);
      await expect(page.locator('.player-card strong')).toHaveText(['Nova', 'Emu']);
      expect(await colors(page)).toEqual(assigned);
      await expect(allowed(page)).toHaveCount(0);
    }
    await host.setOffline(false);
    await guest.setOffline(false);
    await Promise.all([connected(h), connected(g)]);
    await expect(allowed(h)).toHaveCount(8);
    await expect(allowed(g)).toHaveCount(0);
    await cell(h, 8).click();
    await expect(cell(g, 8)).toHaveAttribute('data-mark', 'O');
    await leaveGame(g);
    await expect(h.locator('#join-error')).toContainText('opponent left');
    for (const page of [g, h]) await expect(button(page, 'Resume room')).toHaveCount(0);
  } finally { await host.close(); await guest.close(); }
});

test('public waiting room has an invite and exits directly, and simultaneous searches pair', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop' || (!!process.env.PLAY_URL && !process.env.LIVE_PUBLIC_TEST),
    'The deployed queue check is opt-in.');
  test.setTimeout(85_000);
  const a = await browser.newContext({ baseURL, viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true });
  const b = await browser.newContext({ baseURL });
  const x = await a.newPage(), y = await b.newPage();
  try {
    await Promise.all([setup(x, 'Amy', 'Public match'), setup(y, 'Bea', 'Public match')]);
    await expect(x.locator('#join-code')).toBeHidden();
    await expect(button(x, 'Find public game')).toBeInViewport({ ratio: 1 });
    await button(x, 'Find public game').click();
    await expect(x.locator('#room-qr')).toBeVisible();
    await expect(x.locator('#room-status')).toHaveText('Looking for another player…');
    for (const id of ['#room-back', '#room-code', '#room-qr', '#copy-room', '#share-room'])
      await expect(x.locator(id)).toBeInViewport({ ratio: 1 });
    await button(x, 'Leave room').click();
    await expect(x.locator('#setup')).toBeVisible();
    await x.getByText('Public match', { exact: true }).click();
    await Promise.all([button(x, 'Find public game').click(), button(y, 'Find public game').click()]);
    await Promise.all([connected(x), connected(y)]);
    for (const page of [x, y]) expect((await page.locator('.player-card strong').allTextContents()).sort()).toEqual(['Amy', 'Bea']);
    const first = await allowed(x).count() ? x : y;
    await cell(first, 0).click();
    for (const page of [x, y]) await expect(cell(page, 0)).toHaveAttribute('data-mark', 'X');
    await leaveGame(first);
  } finally { await a.close(); await b.close(); }
});

test('typed private code, full room and original waiting-room invite', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(110_000);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ baseURL })));
  const [h, g, third] = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all([setup(h, 'Alice'), setup(g, 'Gus', 'Join a friend'), setup(third, 'Third', 'Join a friend')]);
    await button(h, 'Create private room').click();
    await expect(h.locator('#room-qr')).toBeVisible({ timeout: 25_000 });
    const code = await h.locator('#room-code').innerText();
    await g.locator('#join-code').fill(code.toLowerCase());
    await button(g, 'Join room').click();
    await Promise.all([connected(h), connected(g)]);
    await third.locator('#join-code').fill(code);
    await button(third, 'Join room').click();
    await expect(third.locator('#join-error')).toContainText('already has two players', { timeout: 30_000 });
    await leaveGame(h);
    await expect(g.locator('#join-error')).toContainText('opponent left');
    // Seed exactly the waiting-host record written by the previously released app.
    await h.evaluate(() => sessionStorage.setItem('ttt:waiting-host', JSON.stringify({
      code: 'L' + crypto.randomUUID().slice(0, 4).toUpperCase().replace(/[^A-F2-9]/g, 'J'),
      token: crypto.randomUUID(), profile: { name: 'Earlier host', color: 'gold' }, savedAt: Date.now(),
    })));
    await h.reload();
    await button(h, 'Not now').click();
    await expect(h.locator('#room-qr')).toBeVisible({ timeout: 25_000 });
    if (!process.env.PLAY_URL) {
      // A missing destination on the public service can time out without an EXPIRE reply.
      const absent = 'chrisawad-tic-tac-toe-v2-room-' + await h.locator('#room-code').innerText();
      await g.routeWebSocket(/\/peerjs\?/, socket => {
        const server = socket.connectToServer();
        socket.onMessage(message => {
          const frame = JSON.parse(String(message));
          if (frame.type !== 'OFFER' || frame.dst !== absent) server.send(message);
        });
      });
    }
    await openPublicLink(g, await h.locator('#invite-link').inputValue(), baseURL!);
    await button(g, 'Not now').click();
    await button(g, 'Join room').click();
    await Promise.all([connected(h), connected(g)]);
    await cell(h, 0).click();
    await expect(cell(g, 0)).toHaveAttribute('data-mark', 'X');
    await leaveGame(g);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('missing room gives a next step after checking both room versions', async ({ page }, info) => {
  test.skip(!!process.env.PLAY_URL || info.project.name !== 'desktop', 'Uses an unregistered code on the local server.');
  test.setTimeout(45_000);
  await page.goto('./?room=ZZZ99');
  await button(page, 'Not now').click();
  await button(page, 'Join room').click();
  await expect(page.locator('#join-error')).toContainText('Check the code', { timeout: 35_000 });
  await expect(page.locator('#join-code')).toHaveValue('ZZZ99');
});
