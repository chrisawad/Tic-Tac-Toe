import { expect, test, type Page } from '@playwright/test';

const square = (page: Page, index: number) => page.getByRole('button', { name: new RegExp('^Square ' + (index + 1) + ',') });
const name = (page: Page, slot: 'one' | 'two') => page.locator('#name-' + slot);
const mode = (page: Page, value: 'ai' | 'local' | 'online') => page.locator('[data-mode="' + value + '"]');

const dismissInstall = (page: Page) => page.getByRole('button', { name: 'Not now' }).click();

async function visit(page: Page) {
  await page.goto('./');
  await dismissInstall(page);
}

async function startLocal(page: Page) {
  await visit(page);
  await mode(page, 'local').click();
  await name(page, 'one').fill('Emu');
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

test('real online room carries a game and rematch between two browser contexts', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!process.env.LIVE_ROOM_TEST || testInfo.project.name !== 'desktop', 'Live PeerJS room smoke test');
  test.setTimeout(85_000);
  await visit(page);
  await mode(page, 'online').click();
  await name(page, 'one').fill('Host');
  await page.getByRole('button', { name: 'Create a room' }).click();
  const code = page.locator('#room-code');
  await expect(code).toHaveText(/^[A-Z2-9]{5}$/, { timeout: 24000 });
  await expect(page.locator('#room-qr')).toBeVisible();
  const invite = await page.locator('#invite-link').inputValue();
  expect(invite).toBe(new URL('?room=' + await code.textContent(), baseURL).href);
  const guest = await browser.newPage();
  try {
    await guest.goto(invite);
    await expect(guest.locator('#install-dialog')).toBeHidden();
    await expect(guest.locator('#join-code')).toHaveValue((await code.textContent())!);
    await name(guest, 'one').fill('Guest');
    await guest.locator('#profile-one').getByRole('radio', { name: 'violet' }).check({ force: true });
    await guest.getByRole('button', { name: 'Join room' }).click();
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
    await guest.close();
  }
});
