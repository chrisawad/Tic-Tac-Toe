import { chromium, expect, test, type Page } from '@playwright/test';
import { openPublicLink, publicGameUrl } from './invite-links';

type Lookup = 'unavailable' | 'denied' | 'pending' | 'dashboard' | 'installed';

async function embeddedBrowser(page: Page, platform: 'Android' | 'iPad', lookup: Lookup, installError?: string) {
  await page.addInitScript(({ platform, lookup, installError }) => {
    if (!location.protocol.startsWith('http')) return;
    localStorage.setItem('ttt:installed', 'yes');
    sessionStorage.setItem('ttt:installed', 'yes');
    localStorage.setItem('glow-trail:install-dialog-shown', 'yes');
    Object.defineProperty(navigator, 'standalone', { value: true });
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = matchMedia(query);
      if (query.includes('display-mode: standalone')) Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
    Object.defineProperty(navigator, 'userAgent', { value: platform === 'Android'
      ? 'Mozilla/5.0 (Linux; Android 16; Pixel; wv)' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15' });
    if (platform === 'iPad') {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    }
    Object.defineProperty(navigator, 'install', {
      value: installError && (async () => { throw new DOMException(installError, installError); }),
    });
    window.addEventListener('beforeinstallprompt', event => {
      if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
    });
    Object.defineProperty(navigator, 'getInstalledRelatedApps', {
      value: lookup === 'unavailable' ? undefined : async () => {
        if (lookup === 'denied') throw new DOMException('Denied', 'SecurityError');
        if (lookup === 'pending') await new Promise(resolve => window.addEventListener('test-installed', resolve, { once: true }));
        const url = new URL(lookup === 'dashboard' ? '../Games-Dashboard/manifest.webmanifest' : 'manifest.webmanifest', location.href);
        return [{ platform: 'webapp', url: url.href }];
      },
    });
    if (lookup === 'denied' || lookup === 'pending') {
      navigator.serviceWorker.register = async () => {
        if (lookup === 'denied') throw new DOMException('Denied', 'SecurityError');
        return new Promise(() => {});
      };
    }
  }, { platform, lookup, installError });
}

async function offerNativePrompt(page: Page) {
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => { document.documentElement.dataset.installClick = String(navigator.userActivation.isActive); },
    userChoice: new Promise(resolve => window.addEventListener('test-accept', () => resolve({ outcome: 'accepted' }), { once: true })),
  })));
}

async function expectCompactInstall(page: Page, action = 'Install app') {
  const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
  await expect(dialog).toHaveAccessibleDescription('Keep Tic Tac Toe on your home screen and play offline after your first visit.');
  await expect(dialog.getByRole('button')).toHaveText([action, 'Not now']);
  await expect(dialog.locator('#install-directions')).toBeHidden();
  await expect(dialog.locator('#install-copy')).toBeHidden();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
}

test('Dashboard offers the same dialog once per visit, on fresh navigation, reload and in a new tab', async ({ page, context, baseURL }) => {
  await embeddedBrowser(page, 'Android', 'unavailable');
  await openPublicLink(page, publicGameUrl + '#from=games-dashboard', baseURL!);
  const guide = page.locator('#install-dialog');
  await expect(guide.locator('#install-directions')).toBeVisible();
  const description = 'Keep Tic Tac Toe on your home screen and play offline after your first visit.';
  await expect(guide.getByRole('heading')).toHaveText('Install Tic Tac Toe');
  await expect(guide).toHaveAccessibleDescription(description);
  await expect(guide.locator('#install-directions li')).toHaveText([
    'Choose Open in Chrome in this window’s menu, or copy the game link below and open it in Chrome.',
    'Tap Chrome’s ⋮ menu, choose Install app or Add to Home screen, and follow the prompt.',
  ]);
  await expect(guide.locator('summary')).toHaveText('Copy the game link');
  await expect(guide.getByRole('button')).toHaveText(['Copy link', 'Not now']);
  const automaticText = await guide.innerText();
  await expect(guide.getByLabel('Game link')).toHaveValue(publicGameUrl);
  await expect(guide.locator('#install-confirm')).toBeHidden();
  await guide.getByRole('button', { name: 'Not now' }).click();
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { value: undefined }));
  await page.getByRole('button', { name: 'Share game' }).click();
  await expect(page.locator('#share-game-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('[data-mode="local"]').click();
  await expect(guide).toBeHidden();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  expect(await guide.innerText()).toBe(automaticText);
  await guide.getByRole('button', { name: 'Not now' }).click();
  await page.goto('./?visit=2#from=games-dashboard');
  await expect(guide).toBeVisible();
  await guide.getByRole('button', { name: 'Not now' }).click();
  await page.reload();
  await expect(guide.locator('#install-directions')).toBeVisible();
  const nextTab = await context.newPage();
  await embeddedBrowser(nextTab, 'Android', 'unavailable');
  await nextTab.goto('./#from=games-dashboard');
  await expect(nextTab.getByRole('dialog', { name: 'Install Tic Tac Toe' })).toBeVisible();
});

test('an unmarked iPad webview shows Safari steps when install and update checks are denied', async ({ page }) => {
  await embeddedBrowser(page, 'iPad', 'denied');
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('./');
  const directions = page.locator('#install-directions');
  await expect(directions).toBeVisible();
  await expect(directions.locator('li').first()).toBeInViewport();
  await expect(directions.locator('li')).toHaveText([
    'Use Open in Safari in this window’s menu, or copy the game link below and open it in Safari. Tap Share.',
    'Choose Add to Home Screen. Turn on Open as Web App if offered, then tap Add.',
  ]);
});

test('Dashboard help appears while lookups are pending and closes on game-specific confirmation', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'pending');
  await page.goto('./#from=games-dashboard');
  await expect(page.locator('#install-directions')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-installed')));
  await expect(page.locator('#install-dialog')).toBeHidden();
  await expect(page.locator('#install-button')).toBeHidden();
});

test('a late Dashboard native prompt switches the open dialog to compact and keeps it compact while installing', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'dashboard');
  await page.goto('./#from=games-dashboard');
  await expect(page.locator('#install-directions')).toBeVisible();
  await page.getByRole('textbox', { name: 'Game link' }).focus();
  await offerNativePrompt(page);
  await expectCompactInstall(page);
  await expect(page.locator('#install-confirm')).toBeFocused();
  await page.locator('#install-dismiss').click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expectCompactInstall(page);
  await page.locator('#install-confirm').click();
  await expect(page.locator('html')).toHaveAttribute('data-install-click', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectCompactInstall(page, 'Installing…');
  await page.evaluate(() => window.dispatchEvent(new Event('test-accept')));
  await expect(page.locator('#install-dialog')).toBeHidden();
  await expect(page.locator('#install-button')).toBeHidden();
});

for (const error of ['NotSupportedError', 'SecurityError']) {
  test('Dashboard native installation handles ' + error, async ({ page }) => {
    await embeddedBrowser(page, 'Android', 'unavailable', error);
    await page.goto('./#from=games-dashboard');
    await expectCompactInstall(page);
    await offerNativePrompt(page);
    await page.locator('#install-confirm').click();
    const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
    await expect(dialog.locator('#install-status')).toHaveText('The installer could not open. Try again or use your browser’s install menu.');
    await expect(dialog.locator('#install-confirm')).toBeHidden();
    await expect(dialog.locator('#install-directions')).toContainText('Open in Chrome');
    await expect(dialog.getByRole('textbox', { name: 'Game link' })).toHaveValue(publicGameUrl);
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await offerNativePrompt(page);
    await expectCompactInstall(page);
    await expect(dialog.locator('#install-status')).toBeEmpty();
  });
}

test('canceling a Dashboard native install keeps the compact dialog available to retry', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'unavailable', 'AbortError');
  await page.goto('./#from=games-dashboard');
  const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
  await dialog.getByRole('button', { name: 'Install app' }).click();
  await expect(dialog.locator('#install-status')).toHaveText('Installation canceled. You can keep playing here.');
  await expectCompactInstall(page);
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expectCompactInstall(page);
});

test('Dashboard launch with a confirmed game installation skips the automatic offer', async ({ page }) => {
  await embeddedBrowser(page, 'iPad', 'installed');
  await page.goto('./#from=games-dashboard');
  await page.locator('[data-mode="local"]').click();
  await expect(page.locator('#setup-title')).toBeVisible();
  await expect(page.locator('#install-dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
});

test('Dashboard room invite offers installation and preserves the prefilled code after dismissal', async ({ page, baseURL }) => {
  await embeddedBrowser(page, 'Android', 'denied');
  await openPublicLink(page, publicGameUrl + '#from=games-dashboard&room=ABC23', baseURL!);
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
  const guide = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
  await guide.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('radio', { name: 'Join a friend' })).toBeChecked();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('#install-title')).toHaveText('Install Tic Tac Toe');
  await expect(page.locator('#install-game-link')).toHaveValue(publicGameUrl);
  await page.locator('#install-dismiss').click();
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
});

test('an invite defers installation while another dialog has priority', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'pending');
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.querySelector<HTMLDialogElement>('#rules-dialog')!.showModal());
  });
  await page.goto('./?room=ABC23');
  await expect(page.locator('#rules-dialog')).toBeVisible();
  // The pending lookup outlives the launch fallback while the rules dialog has priority.
  await expect(page.locator('#install-button')).toBeVisible();
  await expect(page.locator('#install-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.locator('#install-dismiss').click();
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
  await expect(page.getByRole('button', { name: 'Join room' })).toBeVisible();
});

for (const [platform, ua, directions] of [
  ['Android Chrome', 'Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile Safari/537.36',
    ['Open Tic Tac Toe in Chrome.', 'Tap Chrome’s ⋮ menu, choose Install app or Add to Home screen, and follow the prompt.']],
  ['iPhone Safari', 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
    ['Open Tic Tac Toe in Safari and tap Share.', 'Choose Add to Home Screen. Turn on Open as Web App if offered, then tap Add.']],
  ['Mac Safari', 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15', ['In Safari, choose File → Add to Dock, then select Add.']],
  ['desktop Chrome', 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36',
    ['Open Tic Tac Toe in Chrome or Edge and choose the install option in the address bar or browser menu.']],
] as const) {
  test(platform + ' shows the reference wording with the optional copy link', async ({ page }) => {
    await page.addInitScript(ua => {
      Object.defineProperty(navigator, 'userAgent', { value: ua });
      Object.defineProperty(navigator, 'install', { value: undefined });
      window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); event.stopImmediatePropagation(); });
    }, ua);
    await page.goto('./');
    const dialog = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
    await expect(dialog.locator('#install-directions li, #install-directions p')).toHaveText([...directions]);
    await expect(dialog.getByLabel('Game link')).toBeHidden();
    await dialog.getByText('Copy the game link', { exact: true }).click();
    await expect(dialog.getByLabel('Game link')).toHaveValue(publicGameUrl);
  });
}

test('browser Back offers installation on the restored visit', async ({ baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'This exercises a full Chromium browser with its back/forward cache enabled.');
  const browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  try {
    // A worker activating in the background may evict the page before the history traversal.
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto(baseURL!);
    const guide = page.getByRole('dialog', { name: 'Install Tic Tac Toe' });
    await guide.getByRole('button', { name: 'Not now' }).click();
    await page.evaluate(() => window.addEventListener('pageshow', event => {
      if (event.persisted) document.documentElement.dataset.restored = 'yes';
    }));
    await page.goto(new URL('icons/icon-192.png', baseURL).href);
    await page.goBack({ waitUntil: 'commit' });
    await expect(guide).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-restored', 'yes');
    await guide.getByRole('button', { name: 'Not now' }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('[data-mode="local"]').click();
    await expect(guide).toBeHidden();
  } finally { await browser.close(); }
});

test('the preview instructions link to the clean secure game address', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await page.goto('./#from=games-dashboard');
  const directions = page.locator('#install-directions');
  await expect(directions).toHaveText('To install from this preview, open Tic Tac Toe over HTTPS.');
  await expect(directions.getByRole('link', { name: 'Tic Tac Toe over HTTPS' })).toHaveAttribute('href', publicGameUrl);
});
