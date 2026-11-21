import { expect, test, type Page } from '@playwright/test';

const square = (page: Page, index: number) => page.getByRole('button', { name: new RegExp('^Square ' + (index + 1) + ',') });
const name = (page: Page, slot: 'one' | 'two') => page.locator('#name-' + slot);
const mode = (page: Page, value: 'ai' | 'local' | 'online') => page.locator('[data-mode="' + value + '"]');

async function startLocal(page: Page) {
  await page.goto('./');
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
  await page.goto('./');
  await page.getByRole('button', { name: 'Sound' }).click();
  await page.reload();
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

test('install button calls the native prompt and hides on installation', async ({ page }) => {
  await page.addInitScript(() => {
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
  await page.getByRole('button', { name: 'Install app' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-install', 'true');
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
});

test('Chromium install fallback honors a declined prompt', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'install', { value: undefined }); });
  await page.goto('./');
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
  await expect(page.getByRole('button', { name: 'Install help' })).toBeVisible();
});

test('standalone display hides the install affordance', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  await page.goto('./');
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  await expect(mode(page, 'local')).toBeVisible();
});

test('start screen and playfield fit the narrowest phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('./');
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await width()).toBe(320);
  await mode(page, 'local').click();
  expect(await width()).toBe(320);
  await page.getByRole('button', { name: 'Start battle' }).click();
  expect(await width()).toBe(320);
});

test('real online room carries a game and rematch between two browser contexts', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!process.env.LIVE_ROOM_TEST || testInfo.project.name !== 'desktop', 'Live PeerJS room smoke test');
  test.setTimeout(85_000);
  await page.goto('./');
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
    await expect(guest.locator('#join-code')).toHaveValue((await code.textContent())!);
    await name(guest, 'one').fill('Guest');
    await guest.getByRole('button', { name: 'Join room' }).click();
    await expect(page.locator('#turn-status')).toHaveText('Your turn · X', { timeout: 24000 });
    await expect(guest.locator('#turn-status')).toHaveText('Host’s turn · X');
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
  } finally {
    await guest.close();
  }
  await expect(page.locator('#join-error')).toHaveText('Your opponent left the room.', { timeout: 35000 });
});
