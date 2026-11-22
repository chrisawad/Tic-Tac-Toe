import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const square = (page: Page, index: number) => page.getByRole('button', { name: new RegExp('^Square ' + (index + 1) + ',') });
const name = (page: Page, slot: 'one' | 'two') => page.locator('#name-' + slot);
const mode = (page: Page, value: 'ai' | 'local' | 'online') => page.locator('[data-mode="' + value + '"]');

const dismissInstall = (page: Page) => page.getByRole('button', { name: 'Not now' }).click();

async function visit(page: Page) {
  await page.goto('./');
  await dismissInstall(page);
}

async function startLocal(page: Page, firstPlayer = 'Emu') {
  await visit(page);
  await mode(page, 'local').click();
  await name(page, 'one').fill(firstPlayer);
  await name(page, 'two').fill('Nova');
  await page.locator('#profile-one').getByRole('radio', { name: 'gold' }).check({ force: true });
  await page.getByRole('button', { name: 'Start battle' }).click();
}

test('local win, winning line, celebration, rematch, and saved score', async ({ page }) => {
  const exceptions: string[] = [];
  page.on('pageerror', error => exceptions.push(error.message));
  await startLocal(page);
  await expect(page.locator('#turn-status')).toHaveText('Emu’s turn · X');
  for (const i of [0, 2, 4, 3, 8]) await square(page, i).click();
  const result = page.getByRole('dialog', { name: 'Emu wins!' });
  await expect(result).toBeVisible();
  await expect(result.locator('#result-trophy')).toBeVisible();
  await expect(page.locator('.cell.winning')).toHaveCount(3);
  await expect(page.locator('#strike')).toBeVisible();
  await expect.poll(() => result.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(300);
  await expect(result.getByRole('button', { name: 'Rematch' })).toBeFocused();
  await result.getByRole('button', { name: 'Rematch' }).click();
  await expect(page.locator('#turn-status')).toHaveText('Nova’s turn · X');
  await expect(page.locator('#round-counter')).toHaveText('Round 2');
  await expect(page.locator('#score dd')).toHaveText(['1', '0', '0']);
  await square(page, 4).click();
  await page.reload();
  await dismissInstall(page);
  await mode(page, 'local').click();
  await page.getByRole('button', { name: 'Resume match' }).click();
  await expect(square(page, 4)).toHaveAttribute('aria-label', 'Square 5, X');
  await expect(page.locator('#score dd')).toHaveText(['1', '0', '0']);
  expect(exceptions).toEqual([]);
});

test('every winning line grows from its first square through its last on a stationary board', async ({ page }) => {
  await startLocal(page);
  const board = page.locator('#board');
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  for (const [first, middle, last] of lines) {
    const others = Array.from({ length: 9 }, (_, i) => i).filter(i => ![first, middle, last].includes(i));
    for (const i of [first, others[0], middle, others[1]]) await square(page, i).click();
    const before = await board.boundingBox();
    await square(page, last).click();
    const frames = await page.locator('#strike').evaluate(line => {
      const animation = line.getAnimations()[0];
      animation.pause();
      const duration = Number(animation.effect!.getComputedTiming().duration);
      return [0, .5, 1].map(progress => {
        animation.currentTime = duration * progress;
        return line.getBoundingClientRect().toJSON() as DOMRect;
      });
    });
    const [start, halfway, end] = frames;
    expect(Math.max(start.width, start.height)).toBeLessThan(5);
    const length = (rect: DOMRect) => Math.hypot(rect.width, rect.height);
    expect(length(halfway)).toBeGreaterThan(length(end) * .3);
    expect(length(halfway)).toBeLessThan(length(end) * .95);
    const sign = Math.sign(last % 3 - first % 3);
    // The starting cap stays fixed while the other end travels across the cells.
    const startEdge = sign < 0 ? 'right' : 'left';
    expect(Math.abs(halfway[startEdge] - end[startEdge])).toBeLessThan(1);
    expect(Math.abs(halfway.top - end.top)).toBeLessThan(1);
    const center = (await square(page, middle).boundingBox())!;
    expect(Math.abs(end.x + end.width / 2 - center.x - center.width / 2)).toBeLessThan(1);
    expect(Math.abs(end.y + end.height / 2 - center.y - center.height / 2)).toBeLessThan(1);
    await expect(page.locator('#result-dialog')).toBeVisible();
    expect(await board.boundingBox()).toEqual(before);
    await page.getByRole('button', { name: 'Rematch' }).click();
    expect(await board.boundingBox()).toEqual(before);
  }
});

test('a long winner name fits beside the result with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const winner = 'W'.repeat(20);
  await startLocal(page, winner);
  for (const i of [2, 0, 4, 1]) await square(page, i).click();
  const board = await page.locator('#board').boundingBox();
  await square(page, 6).click();
  await expect(page.locator('#turn-status')).toHaveText(winner + ' wins the round!');
  await expect(page.locator('#strike')).toBeVisible();
  expect(await page.locator('#strike').evaluate(line => line.getAnimations().length)).toBe(0);
  expect(await page.locator('#board').boundingBox()).toEqual(board);
});

test('draw uses its own dialog and can return to the board', async ({ page }) => {
  await startLocal(page);
  for (const i of [0, 1, 2, 4, 3, 5, 7, 6, 8]) await square(page, i).click();
  const result = page.getByRole('dialog', { name: 'It’s a draw!' });
  await expect(result).toBeVisible();
  await expect(result.locator('#result-draw')).toBeVisible();
  await expect(page.locator('#strike')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(result).toBeHidden();
  await expect(page.locator('#score dd')).toHaveText(['0', '1', '0']);
  await page.getByRole('button', { name: 'Round result' }).click();
  await expect(result).toBeVisible();
});

test('T-3PO replies, sound preference persists, keyboard navigates the board', async ({ page }) => {
  await visit(page);
  await page.getByRole('button', { name: 'Sound' }).click();
  await page.reload();
  await dismissInstall(page);
  await expect(page.getByRole('button', { name: 'Sound' })).toHaveAttribute('aria-pressed', 'false');
  await mode(page, 'ai').click();
  await page.getByRole('radio', { name: 'Hard' }).check({ force: true });
  await expect(page.locator('#difficulty-hint')).toContainText('perfect game');
  await page.getByRole('button', { name: 'Start battle' }).click();
  await square(page, 0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(square(page, 1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(square(page, 1)).toHaveAttribute('aria-label', 'Square 2, X');
  await expect(page.getByRole('button', { name: /Square \d, O/ })).toHaveCount(1);
});

test('manifest, icons, install eligibility, and offline play under the Pages scope', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker unavailable')), 10000)),
    ]);
  });
  await page.reload();
  const session = await context.newCDPSession(page);
  const response = await session.send('Page.getInstallabilityErrors');
  expect(response.installabilityErrors).toEqual([]);
  const details = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const manifest = await (await fetch(link.href)).json();
    const icons = await Promise.all(manifest.icons.map(async (icon: { src: string }) => {
      const response = await fetch(new URL(icon.src, link.href));
      return response.ok && response.headers.get('content-type')?.includes('image/png');
    }));
    return {
      start: new URL(manifest.start_url, link.href).href,
      scope: new URL(manifest.scope, link.href).href,
      display: manifest.display, icons,
      worker: navigator.serviceWorker.controller?.scriptURL,
    };
  });
  expect(details).toMatchObject({ start: page.url(), scope: page.url(), display: 'standalone', icons: [true, true, true], worker: new URL('sw.js', page.url()).href });
  await context.setOffline(true);
  await startLocal(page);
  await square(page, 0).click();
  await expect(square(page, 0)).toHaveAttribute('aria-label', 'Square 1, X');
  await page.getByRole('button', { name: 'All modes' }).click();
  await mode(page, 'ai').click();
  await page.getByRole('button', { name: 'Start battle' }).click();
  await square(page, 0).click();
  await expect(page.getByRole('button', { name: /Square \d, O/ })).toHaveCount(1);
});

test('install popup opens on launch, calls the native prompt, and stays hidden after installation', async ({ page }) => {
  await page.addInitScript(() => {
    // Emulate an installed browser on reload, which no longer advertises eligibility.
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    Object.defineProperty(navigator, 'install', {
      configurable: true,
      value: () => {
        document.documentElement.dataset.install = String(navigator.userActivation.isActive);
        window.dispatchEvent(new Event('appinstalled'));
        return Promise.resolve();
      },
    });
  });
  await page.goto('./');
  const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
  await dialog.getByRole('button', { name: 'Install app' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-install', 'true');
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  await expect(dialog).toBeHidden();
});

test('Chromium install fallback honors a declined prompt', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'install', { value: undefined }); });
  await visit(page);
  await page.evaluate(() => {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: () => {
        document.documentElement.dataset.install = String(navigator.userActivation.isActive);
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(event);
  });
  await page.locator('#install-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-install', 'true');
  await expect(page.locator('#install-button')).toBeHidden();
  await page.locator('#install-help-button').click();
  await expect(page.locator('#install-steps')).toBeVisible();
});

test('manual install instructions stay accessible from the toolbar and return on the next visit', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'install', { value: undefined });
    Object.defineProperty(navigator, 'userAgent', { value: 'iPhone' });
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  });
  await page.goto('./');
  const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
  await expect(dialog).toContainText('Add to Home Screen');
  await page.keyboard.press('Escape');
  await mode(page, 'online').click();
  await page.getByRole('button', { name: 'Install app' }).click();
  await expect(dialog).toBeVisible();
  await dismissInstall(page);
  await expect(page.locator('#setup-title')).toBeVisible();
  await page.reload();
  await expect(dialog).toBeVisible();

  await page.goto('./?room=abc23');
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
  await page.locator('#join-code').click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Install app' }).click();
  await expect(dialog).toContainText('Add to Home Screen');
  await dismissInstall(page);
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
});

test('an existing related app skips the install popup in a browser tab', async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    Object.defineProperty(navigator, 'getInstalledRelatedApps', {
      value: async () => [{ platform: 'webapp', url: new URL('manifest.webmanifest', location.href).href }],
    });
  });
  await page.goto('./');
  await expect(page.locator('#install-help-button')).toBeHidden();
  await expect(page.locator('#install-button')).toBeHidden();
  await expect(page.locator('#install-dialog')).toBeHidden();
  await mode(page, 'local').click();
});

test('standalone display hides the install affordance', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  await page.goto('./');
  await expect(page.locator('#install-dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  await expect(mode(page, 'local')).toBeVisible();
});

test('start screen and playfield fit the narrowest phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await visit(page);
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await width()).toBe(320);
  await mode(page, 'local').click();
  expect(await width()).toBe(320);
  await page.getByRole('button', { name: 'Start battle' }).click();
  expect(await width()).toBe(320);
  for (const [w, h] of [[320, 480], [568, 320], [667, 375], [844, 390], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    const layout = await page.locator('#board').evaluate(board => {
      const rect = board.getBoundingClientRect();
      const slot = board.closest('.board-space')!.getBoundingClientRect();
      return { size: rect.width, height: rect.height, available: Math.min(slot.width, slot.height, 600),
        documentHeight: document.documentElement.scrollHeight, documentWidth: document.documentElement.scrollWidth };
    });
    expect(layout.size).toBeCloseTo(layout.height, 0);
    expect(layout.size).toBeCloseTo(layout.available, 0);
    expect(layout.size).toBeGreaterThan(150);
    if (w === 320) expect(layout.size).toBeGreaterThan(260);
    if (w === 1024) expect(layout.size).toBeGreaterThan(555);
    if (w > h && h <= 390) expect(layout.size).toBeGreaterThan(h * .88);
    if (w === 1920) expect(layout.size).toBe(600);
    expect(layout.documentWidth).toBe(w);
    expect(layout.documentHeight, `viewport ${w} × ${h}`).toBeLessThanOrEqual(h + 1);
  }
});

test('short landscape screens fit the menu, board and rematch through rotation', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Not now' })).toBeInViewport({ ratio: 1 });
  await dismissInstall(page);
  for (const value of ['ai', 'local', 'online'] as const) {
    await expect(mode(page, value)).toBeInViewport({ ratio: 1 });
  }
  await mode(page, 'online').click();
  await page.getByText('Join a friend', { exact: true }).click();
  const room = await page.locator('#join-code').boundingBox();
  const profile = await page.locator('#profile-one').boundingBox();
  expect(room!.x + room!.width).toBeLessThan(profile!.x);
  await expect(page.getByRole('button', { name: 'Join room' })).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'All modes' }).click();
  await mode(page, 'local').click();
  await expect(page.getByRole('button', { name: 'Start battle' })).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Start battle' }).click();
  const board = await page.locator('#board').boundingBox();
  const nav = await page.locator('.topbar').boundingBox();
  expect(board!.x).toBeGreaterThan(nav!.x + nav!.width);
  await expect(page.locator('#board')).toBeInViewport({ ratio: 1 });
  await square(page, 0).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(square(page, 0)).toHaveAttribute('aria-label', 'Square 1, X');
  await square(page, 3).click();
  await page.setViewportSize({ width: 568, height: 320 });
  for (const cell of [1, 4, 2]) await square(page, cell).click();
  const rematch = page.getByRole('button', { name: 'Rematch' });
  await expect(rematch).toBeInViewport({ ratio: 1 });
  expect(await page.locator('#board').boundingBox()).toEqual(board);
  await rematch.click();
  await expect(page.locator('#round-counter')).toHaveText('Round 2');
});

test('online setup keeps host and join actions distinct and routes invites to Join', async ({ page }) => {
  await visit(page);
  await mode(page, 'online').click();
  await expect(page.getByRole('button', { name: 'Create a room' })).toBeVisible();
  await expect(page.getByLabel('Room code', { exact: true })).toBeHidden();
  await page.getByText('Join a friend', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create a room' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.locator('#join-error')).toContainText('five-character');
  await expect(page.locator('#join-code')).toBeFocused();
  await expect(page.locator('#join-code')).toHaveAttribute('aria-invalid', 'true');
  await page.getByText('Host a game', { exact: true }).click();
  await expect(page.locator('#join-error')).toBeEmpty();
  await expect(page.locator('#join-code')).not.toHaveAttribute('aria-invalid');
  await page.goto('./?room=ABC23');
  await expect(page.locator('#install-dialog')).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Join a friend' })).toBeChecked();
  await expect(page.getByLabel('Room code', { exact: true })).toHaveValue('ABC23');
});

test('offline invite explains the network failure and preserves a valid code', async ({ page, context }) => {
  await page.goto('./?room=ABC23');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Join room' }).click();
  const error = page.locator('#join-error');
  await expect(error).toContainText('offline');
  await expect(error).toBeFocused();
  await expect(error).toBeInViewport();
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
  await expect(page.locator('#join-code')).not.toHaveAttribute('aria-invalid');
});

test('a shared waiting room survives suspension and relaunch and clears on exit', async ({ page, context, isMobile }) => {
  const registrations: string[] = [];
  let owner: string | null = null;
  let signaling: WebSocketRoute;
  await context.routeWebSocket(/\/peerjs\?/, socket => {
    signaling = socket;
    const params = new URL(socket.url()).searchParams;
    registrations.push(params.get('id')!);
    owner ??= params.get('token');
    socket.send(JSON.stringify({ type: params.get('token') === owner ? 'OPEN' : 'ID-TAKEN' }));
  });
  await context.addInitScript(standalone => {
    if (standalone) Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(navigator, 'share', { value: (data: ShareData) => {
      document.documentElement.dataset.shared = data.url;
      return new Promise(resolve => window.addEventListener('pageshow', resolve, { once: true }));
    } });
  }, isMobile);
  await page.goto('./');
  if (!isMobile) await dismissInstall(page);
  await mode(page, 'online').click();
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect(page.locator('#room-qr')).toBeVisible();
  const invite = await page.locator('#invite-link').inputValue();
  expect([...new URL(invite).searchParams.keys()]).toEqual(['room']);
  await page.locator('#share-room').click();
  await expect(page.locator('html')).toHaveAttribute('data-shared', invite);
  await signaling!.close({ code: 1001, reason: 'Connection interrupted' });
  await expect.poll(() => registrations.length).toBe(2);
  await expect(page.locator('#room-status')).toContainText('Waiting for a friend');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => registrations.length).toBe(3);
  await expect(page.locator('#room-status')).toContainText('Waiting for a friend');
  const restored = isMobile ? await context.newPage() : page;
  if (isMobile) await page.close();
  await restored.goto('./');
  await expect(restored.locator('#room-status')).toContainText('Waiting for a friend');
  await expect(restored.locator('#invite-link')).toHaveValue(invite);
  await expect(restored.locator('#install-dialog')).toBeHidden();
  expect(registrations).toEqual(Array(4).fill('chrisawad-tic-tac-toe-v1-' + new URL(invite).searchParams.get('room')));
  await restored.locator('#room-back').click();
  await restored.reload();
  await expect(restored.locator('#home')).toBeVisible();
});

test('opening a second installed window preserves the waiting room in the original', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  let connections = 0;
  await context.routeWebSocket(/\/peerjs\?/, socket => {
    connections++;
    socket.send(JSON.stringify({ type: 'OPEN' }));
  });
  await page.goto('./');
  await mode(page, 'online').click();
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect(page.locator('#room-qr')).toBeVisible();
  const invite = await page.locator('#invite-link').inputValue();
  const other = await context.newPage();
  await other.goto('./');
  await expect(other.locator('#join-error')).toContainText('another game window');
  expect(connections).toBe(1);
  await other.close();
  await page.reload();
  await expect(page.locator('#room-status')).toContainText('Waiting for a friend');
  await expect(page.locator('#invite-link')).toHaveValue(invite);
  expect(connections).toBe(2);
});

test('an older saved room with an occupied code offers a new invite immediately', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(() => sessionStorage.setItem('ttt:waiting-host', JSON.stringify({
    code: 'ABC23', profile: { name: 'Host', color: 'violet' }, savedAt: Date.now(),
  })));
  let attempts = 0;
  await context.routeWebSocket(/\/peerjs\?/, socket => {
    const occupied = new URL(socket.url()).searchParams.get('id')?.endsWith('ABC23');
    if (occupied) attempts++;
    socket.send(JSON.stringify({ type: occupied ? 'ID-TAKEN' : 'OPEN' }));
  });
  await page.reload();
  await expect(page.locator('#join-error')).toContainText('create a new room and share its new invite');
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect(page.locator('#room-qr')).toBeVisible();
  await expect(page.locator('#room-code')).not.toHaveText('ABC23');
});

const testRelay = process.env.TEST_TURN_URL;
const liveRelay = process.env.LIVE_TURN_TEST === '1';
const requireRelay = Boolean(testRelay) || liveRelay;
const testWorker = testRelay && process.env.TEST_TURN_WORKER_URL;
const retryThroughRelay = Boolean(testWorker) || liveRelay;
const routeTest = retryThroughRelay ? 'a failed first connection automatically recovers through the relay'
  : requireRelay ? 'two browsers show a relayed game connection' : 'two browsers can play directly with an unresolvable relay and no STUN server';
test(routeTest, async ({ page, playwright, isMobile }) => {
  test.skip(!process.env.LIVE_ROOM_TEST, 'Live local network connection test');
  test.setTimeout(65_000);
  const secondBrowser = await playwright.chromium.launch();
  try {
    const guest = await secondBrowser.newPage({ isMobile });
    let credentialRequests = 0;
    for (const playerPage of [page, guest]) {
      const servers = [{ urls: testRelay || 'turn:relay.invalid:3478', username: process.env.TEST_TURN_USER || 'test', credential: process.env.TEST_TURN_PASSWORD || 'test' }];
      const config: RTCConfiguration = {};
      if (requireRelay && !retryThroughRelay) config.iceTransportPolicy = 'relay';
      if (testWorker) {
        await playerPage.route(testWorker, route => {
          expect(route.request().method()).toBe('POST');
          credentialRequests++;
          return route.fulfill({ json: { iceServers: servers }, headers: { 'Access-Control-Allow-Origin': '*' } });
        });
      } else if (!liveRelay) {
        config.iceServers = servers;
      }
      await playerPage.addInitScript(({ overrides, interruptFirstAnswer }) => {
        window.RTCPeerConnection = class extends RTCPeerConnection {
          constructor(config?: RTCConfiguration) {
            super({ ...config, ...overrides });
          }
          override async setRemoteDescription(description: RTCSessionDescriptionInit) {
            await super.setRemoteDescription(description);
            if (interruptFirstAnswer && description.type === 'answer') {
              interruptFirstAnswer = false;
              Object.defineProperty(this, 'iceConnectionState', { value: 'failed' });
              this.dispatchEvent(new Event('iceconnectionstatechange'));
            }
          }
        };
      }, { overrides: config, interruptFirstAnswer: retryThroughRelay && playerPage === guest });
    }
    await visit(page);
    await mode(page, 'online').click();
    await page.getByRole('button', { name: 'Create a room' }).click();
    await expect(page.locator('#room-qr')).toBeVisible();
    await guest.goto(await page.locator('#invite-link').inputValue());
    await guest.getByRole('button', { name: 'Join room' }).click();
    if (retryThroughRelay) await expect(guest.locator('#room-status')).toContainText('Retrying through the backup relay');
    await expect(page.locator('#turn-status')).toHaveText('Your turn · X', { timeout: 42_000 });
    for (const device of [page, guest]) {
      await expect(device.locator('#connection-route')).toHaveText(requireRelay ? 'Via relay' : 'Direct');
      await expect(device.locator('#connection-route')).toBeInViewport({ ratio: 1 });
    }
    if (testWorker) expect(credentialRequests).toBe(2);
    if (isMobile) {
      await page.setViewportSize({ width: 568, height: 320 });
      await expect(page.locator('#connection-route')).toBeInViewport({ ratio: 1 });
      await expect(page.locator('#board')).toBeInViewport({ ratio: 1 });
    }
    await square(page, 4).click();
    await expect(guest.locator('#turn-status')).toHaveText('Your turn · O');
  } finally {
    await secondBrowser.close();
  }
});

test('real online room carries a game and rematch between two browser contexts', async ({ page, browser, baseURL }) => {
  test.skip(!process.env.LIVE_ROOM_TEST, 'Live online room smoke test');
  test.setTimeout(85_000);
  await visit(page);
  await mode(page, 'online').click();
  await name(page, 'one').fill('Host');
  const registration = page.waitForEvent('websocket', socket => new URL(socket.url()).searchParams.has('token'));
  await page.getByRole('button', { name: 'Create a room' }).click();
  const registrationUrl = (await registration).url();
  const code = page.locator('#room-code');
  await expect(code).toHaveText(/^[A-Z2-9]{5}$/, { timeout: 24000 });
  await expect(page.locator('#room-qr')).toBeVisible();
  const invite = await page.locator('#invite-link').inputValue();
  const sharedCode = (await code.textContent())!;
  expect(invite).toBe(new URL('?room=' + sharedCode, baseURL).href);
  const hostTab = await page.context().newCDPSession(page);
  await page.context().setOffline(true);
  await expect(page.locator('#room-status')).toContainText('back online');
  await hostTab.send('Page.setWebLifecycleState', { state: 'frozen' });
  const guest = await browser.newPage();
  let staleSocket: WebSocket | undefined;
  try {
    await guest.goto(invite);
    await expect(guest.locator('#install-dialog')).toBeHidden();
    await expect(guest.locator('#join-code')).toHaveValue(sharedCode);
    await name(guest, 'one').fill('Guest');
    await guest.locator('#profile-one').getByRole('radio', { name: 'violet' }).check({ force: true });
    await guest.getByRole('button', { name: 'Join room' }).click();
    await expect(guest.locator('#room-status')).toContainText('Waiting for room', { timeout: 24000 });
    // Keep this test host's registration occupied, as if its phone lost the socket
    // without the service noticing. It stays registered while the host resumes.
    staleSocket = new WebSocket(registrationUrl);
    await new Promise<void>((resolve, reject) => {
      staleSocket!.onmessage = event => JSON.parse(String(event.data)).type === 'OPEN'
        ? resolve() : reject(new Error('The test registration was refused'));
      staleSocket!.onerror = () => reject(new Error('The test registration could not connect'));
    });
    await hostTab.send('Page.setWebLifecycleState', { state: 'active' });
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.locator('#invite-link')).toHaveValue(invite);
    await expect(page.locator('#turn-status')).toHaveText('Your turn · X', { timeout: 24000 });
    await expect(guest.locator('#turn-status')).toHaveText('Host’s turn · X');
    const playerColors = (p: Page) => p.locator('.player-card').evaluateAll(cards =>
      cards.map(card => (card as HTMLElement).style.getPropertyValue('--player')));
    const assigned = await playerColors(page);
    expect(assigned[0]).toBe('#ad98ff');
    expect(assigned[1]).not.toBe(assigned[0]);
    expect(await playerColors(guest)).toEqual(assigned);
    for (const [player, cell] of [[page, 0], [guest, 3], [page, 1], [guest, 4], [page, 2]] as const) {
      await square(player, cell).click();
    }
    const hostResult = page.getByRole('dialog', { name: 'Host wins!' });
    const guestResult = guest.getByRole('dialog', { name: 'Host wins!' });
    await expect(hostResult).toBeVisible();
    await expect(guestResult).toBeVisible();
    await hostResult.getByRole('button', { name: 'Rematch' }).click();
    await expect(hostResult).toContainText('Waiting for your opponent');
    await guestResult.getByRole('button', { name: 'Rematch' }).click();
    await expect(guest.locator('#turn-status')).toHaveText('Your turn · X');
    await expect(page.locator('#round-counter')).toHaveText('Round 2');
    await expect(guest.locator('#score dd')).toHaveText(['1', '0', '0']);
    expect(await playerColors(guest)).toEqual(assigned);
    await guest.getByRole('button', { name: 'All modes' }).click();
    await guest.getByRole('button', { name: 'Leave room', exact: true }).click();
    await expect(page.locator('#join-error')).toHaveText('Your opponent left the room.');
  } finally {
    staleSocket?.close();
    await guest.close();
  }
});
