const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const isRoomCode = (value: string) => /^[A-HJ-NP-Z2-9]{5}$/.test(value);

export function newRoomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), value => letters[value % letters.length]).join('');
}

export function inviteURL(code: string, page = location.href) {
  const url = new URL(page);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.href;
}

export function readInviteCode(url: URL) {
  const code = url.searchParams.get('room')?.toUpperCase() ?? '';
  return isRoomCode(code) ? code : null;
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
    try { await navigator.share({ ...share, url }); }
    catch (error) {
      if (current === url && !(error instanceof DOMException && error.name === 'AbortError')) await copy();
    }
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
      ui.share.hidden = !navigator.share;
      ui.qr.hidden = true;
      try {
        const { default: QR } = await import('qrcode');
        if (current !== url) return;
        await QR.toCanvas(ui.qr, url, { width: 176, margin: 2, color: { dark: '#181427', light: '#ffffff' } });
        if (current === url) ui.qr.hidden = false;
      } catch { /* The link still works without a QR code. */ }
    },
    clear,
    dispose() { listeners.abort(); clear(); },
  };
}
