import type { Page } from '@playwright/test';

export const publicGameUrl = 'https://tictactoe.chrisawad.com/';
export const publicInvite = (code: string) => publicGameUrl + '#room=' + code;

export async function openPublicLink(page: Page, link: string, baseURL: string) {
  if (!process.env.PLAY_URL) {
    // Model the forwarding domain’s 301 to a bare game root. Chromium carries the fragment.
    await page.route(publicGameUrl, route => route.fulfill({
      status: 301, headers: { Location: baseURL },
    }), { times: 1 });
  }
  await page.goto(link);
}
