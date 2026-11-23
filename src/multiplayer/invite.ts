const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function createRoomCodes(length = 5) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 64) throw new RangeError('Invalid room code length');
  const pattern = new RegExp('^[A-HJ-NP-Z2-9]{' + length + '}$');
  return {
    length,
    isRoomCode: (value: string) => typeof value === 'string' && pattern.test(value),
    newRoomCode: () => Array.from(crypto.getRandomValues(new Uint8Array(length)), value => letters[value % letters.length]).join(''),
  };
}
export const { isRoomCode, newRoomCode } = createRoomCodes();

export function inviteURL(code: string, page = location.href) {
  const url = new URL(page);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.href;
}

export function readInviteCode(url: URL, codes = { isRoomCode }) {
  const code = url.searchParams.get('room')?.toUpperCase() ?? '';
  return codes.isRoomCode(code) ? code : null;
}

export async function drawInviteQR(canvas: HTMLCanvasElement, url: string, width = 176, margin = 2) {
  const { toCanvas } = await import('qrcode');
  await toCanvas(canvas, url, { width, margin, errorCorrectionLevel: 'M', color: { dark: '#181427', light: '#ffffff' } });
}

/** Returns false when the caller should offer its clipboard, email or link fallback. */
export async function shareInvite(data: ShareData) {
  if (!navigator.share) return false;
  try { await navigator.share(data); return true; }
  catch (error) { return error instanceof Error && error.name === 'AbortError'; }
}

type InviteElements = {
  code: HTMLElement;
  link: HTMLInputElement;
  qr: HTMLCanvasElement;
  copy: HTMLButtonElement;
  share: HTMLButtonElement;
};

export function createInviteControls(ui: InviteElements, share: { title: string; text: string }, copied: () => void) {
  const listeners = new AbortController();
  let current = '';
  async function copy() {
    const url = current;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (current === url) copied();
    } catch {
      if (current !== url) return;
      ui.link.hidden = false;
      ui.link.focus();
      ui.link.select();
    }
  }
  ui.copy.addEventListener('click', copy, { signal: listeners.signal });
  ui.share.addEventListener('click', async () => {
    const url = current;
    if (!url) return;
    if (!await shareInvite({ ...share, url }) && current === url) await copy();
  }, { signal: listeners.signal });
  function clear() {
    current = '';
    ui.link.hidden = true;
    ui.link.value = '';
    ui.code.textContent = '';
    ui.qr.hidden = true;
  }
  return {
    async show(code: string) {
      const url = inviteURL(code);
      current = url;
      ui.code.textContent = code;
      ui.link.value = url;
      ui.share.hidden = false;
      ui.qr.hidden = true;
      try {
        await drawInviteQR(ui.qr, url);
        if (current === url) ui.qr.hidden = false;
      } catch { /* The link still works without a QR code. */ }
    },
    clear,
    dispose() { listeners.abort(); clear(); },
  };
}
