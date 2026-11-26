import { expect, test, type Page } from '@playwright/test';
import { openPublicLink, publicGameUrl } from './invite-links';

type Lookup = 'unavailable' | 'denied' | 'pending' | 'dashboard' | 'installed';

async function embeddedBrowser(page: Page, platform: 'Android' | 'iPad', lookup: Lookup) {
  await page.addInitScript(({ platform, lookup }) => {
    if (!location.protocol.startsWith('http')) return;
    localStorage.setItem('ttt:installed', 'yes');
    sessionStorage.setItem('ttt:installed', 'yes');
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
    Object.defineProperty(navigator, 'install', { value: undefined });
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
  }, { platform, lookup });
}

test('Dashboard entry shows Android steps through the public redirect and offers them again on a new visit', async ({ page, baseURL }) => {
  await embeddedBrowser(page, 'Android', 'unavailable');
  await openPublicLink(page, publicGameUrl + '#from=games-dashboard', baseURL!);
  const guide = page.locator('#install-dialog');
  await expect(guide.locator('#install-directions')).toBeVisible();
  await expect(guide).toContainText('Open in Chrome');
  await expect(guide).toContainText('Add to Home screen');
  await expect(guide.getByLabel('Game link')).toHaveValue(publicGameUrl);
  await expect(guide.locator('#install-confirm')).toBeHidden();
  await guide.getByRole('button', { name: 'Not now' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(guide).toBeHidden();
  await page.getByRole('button', { name: 'How to install' }).click();
  await expect(guide.getByRole('heading')).toHaveText('How to install');
  await guide.getByRole('button', { name: 'Done' }).click();
  await page.reload();
  await expect(guide.locator('#install-directions')).toBeVisible();
});

test('an unmarked iPad webview shows Safari steps when install and update checks are denied', async ({ page }) => {
  await embeddedBrowser(page, 'iPad', 'denied');
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('./');
  const directions = page.locator('#install-directions');
  await expect(directions).toBeVisible();
  await expect(directions.locator('li').first()).toBeInViewport();
  await expect(directions).toContainText('Safari');
  await expect(directions).toContainText('Tap Share, then Add to Home Screen');
  await expect(directions).toContainText('tap Add');
});

test('Dashboard help appears while lookups are pending and closes on game-specific confirmation', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'pending');
  await page.goto('./#from=games-dashboard');
  await expect(page.locator('#install-directions')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-installed')));
  await expect(page.locator('#install-dialog')).toBeHidden();
});

test('Dashboard installation leaves the game guide and captured native prompt available', async ({ page }) => {
  await embeddedBrowser(page, 'Android', 'dashboard');
  await page.goto('./#from=games-dashboard');
  await expect(page.locator('#install-directions')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => { document.documentElement.dataset.installClick = String(navigator.userActivation.isActive); },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  })));
  await expect(page.locator('#install-directions')).toBeVisible();
  await page.locator('#install-confirm').click();
  await expect(page.locator('html')).toHaveAttribute('data-install-click', 'true');
  await expect(page.locator('#install-dialog')).toBeHidden();
});

test('Dashboard launch with a confirmed game installation skips the automatic offer', async ({ page }) => {
  await embeddedBrowser(page, 'iPad', 'installed');
  await page.goto('./#from=games-dashboard');
  await page.locator('[data-mode="local"]').click();
  await expect(page.locator('#setup-title')).toBeVisible();
  await expect(page.locator('#install-dialog')).toBeHidden();
});

test('Dashboard marker preserves a room invite and keeps the install guide on demand', async ({ page, baseURL }) => {
  await embeddedBrowser(page, 'Android', 'denied');
  await openPublicLink(page, publicGameUrl + '#from=games-dashboard&room=ABC23', baseURL!);
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
  await page.locator('#install-help-button').click();
  await expect(page.locator('#install-title')).toHaveText('How to install');
  await expect(page.locator('#install-game-link')).toHaveValue(publicGameUrl);
  await page.locator('#install-dismiss').click();
  await expect(page.locator('#join-code')).toHaveValue('ABC23');
});
