import { setupUpdates } from './update';

type NativeInstall = Event & {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type InstallNavigator = Navigator & {
  standalone?: boolean;
  install?: () => Promise<unknown>;
  getInstalledRelatedApps?: () => Promise<{ platform: string; id?: string; url?: string }[]>;
};

export function setupInstall(
  install: HTMLButtonElement,
  dialog: HTMLDialogElement,
  update: HTMLButtonElement,
  beforeUpdateReload: () => void,
) {
  const nav = navigator as InstallNavigator;
  const display = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  const confirm = dialog.querySelector<HTMLButtonElement>('#install-confirm')!;
  const confirmLabel = confirm.querySelector('span')!;
  const status = dialog.querySelector<HTMLElement>('#install-status')!;
  const steps = dialog.querySelector<HTMLElement>('#install-steps')!;
  const copy = dialog.querySelector<HTMLDetailsElement>('#install-copy')!;
  const copyStatus = dialog.querySelector<HTMLElement>('#install-copy-status')!;
  const sources = new URLSearchParams(location.hash.slice(1)).getAll('from');
  const appleMobile = /iPhone|iPad|iPod/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/i.test(nav.userAgent);
  const embedded = isEmbeddedLaunch(sources, appleMobile, android);
  // The game's own launcher is marked. A Dashboard window can report the same display mode.
  const gameLaunch = !embedded && sources.includes('tictactoe-app');
  let pending: NativeInstall | undefined;
  let installed = false;
  let related = false;
  let readyToOffer = false;
  let shownThisVisit = false;
  let busy = false;
  let nativeFailed = false;
  const nativeAvailable = () => typeof nav.install === 'function' && !nativeFailed;
  const canInstall = () => isSecureContext && (nativeAvailable() || Boolean(pending));
  const confirmed = () => installed || related || (gameLaunch && (display.matches || nav.standalone === true));

  function openDialog() {
    if (confirmed() || dialog.open) return;
    status.textContent = '';
    copyStatus.textContent = '';
    copy.open = embedded;
    dialog.showModal();
    shownThisVisit = true;
    if (!embedded && canInstall()) confirm.focus();
  }

  function reflect() {
    install.hidden = confirmed();
    confirm.hidden = !busy && !canInstall();
    confirm.setAttribute('aria-disabled', String(busy));
    confirmLabel.textContent = busy ? 'Installing…' : 'Install app';
    steps.hidden = !embedded && !confirm.hidden;
    if (install.hidden) {
      if (dialog.open) dialog.close();
      return;
    }
    if (readyToOffer && !shownThisVisit && !document.hidden && !document.querySelector('dialog[open]')) openDialog();
  }

  let latestCheck = 0;
  async function checkRelated() {
    const check = ++latestCheck;
    try {
      if (!isSecureContext || !nav.getInstalledRelatedApps) return;
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const manifest = new URL('manifest.webmanifest', base).href;
      const apps = await nav.getInstalledRelatedApps();
      if (check !== latestCheck) return;
      related = apps.some(app => app.platform === 'webapp' && (app.id === base.href || app.url === manifest));
      reflect();
    } catch { /* The browser’s installation instructions remain available. */ }
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pending = event as NativeInstall;
    reflect();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    pending = undefined;
    reflect();
  });
  window.addEventListener('focus', () => { reflect(); void checkRelated(); });
  document.addEventListener('visibilitychange', reflect);
  display.addEventListener('change', reflect);
  // A pending offer waits for the current dialog, including a restored round result.
  document.addEventListener('close', () => requestAnimationFrame(reflect), true);

  async function requestInstall() {
    if (busy || confirmed() || !canInstall()) return;
    busy = true;
    status.textContent = '';
    reflect();
    const canceled = 'Installation canceled. You can keep playing here.';
    try {
      if (nativeAvailable()) {
        await nav.install!();
        installed = true;
      } else if (pending) {
        const event = pending;
        pending = undefined;
        await event.prompt();
        if ((await event.userChoice).outcome === 'accepted') installed = true;
        else status.textContent = canceled;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') status.textContent = canceled;
      else {
        nativeFailed = true;
        status.textContent = 'The installer could not open. Try again or use your browser’s install menu.';
      }
    } finally {
      busy = false;
      reflect();
    }
  }

  const directions = dialog.querySelector<HTMLElement>('#install-directions')!;
  directions.innerHTML = installDirections(appleMobile, android, embedded);
  const gameLink = dialog.querySelector<HTMLInputElement>('#install-game-link')!;
  for (const link of directions.querySelectorAll('a')) link.href = gameLink.value;
  install.addEventListener('click', openDialog);
  confirm.addEventListener('click', requestInstall);
  let visit = 0;
  function beginVisit() {
    const current = ++visit;
    shownThisVisit = dialog.open;
    readyToOffer = false;
    installed = false;
    related = false;
    function enableLaunchOffer() {
      if (visit !== current) return;
      readyToOffer = true;
      reflect();
    }
    // A pending platform lookup must not hide the guide indefinitely.
    const deadline = window.setTimeout(enableLaunchOffer, 400);
    void checkRelated().then(() => { clearTimeout(deadline); enableLaunchOffer(); });
  }
  // Back/Forward can restore this exact document. Focus and share-sheet returns stay in the same visit.
  window.addEventListener('pageshow', event => { if (event.persisted) beginVisit(); });
  beginVisit();
  setupUpdates(update, dialog, beforeUpdateReload);
}

function isEmbeddedLaunch(sources: string[], appleMobile: boolean, android: boolean) {
  if (sources.includes('games-dashboard') || window !== window.top) return true;
  const referrer = document.referrer ? new URL(document.referrer) : undefined;
  if (referrer?.hostname === 'games.chrisawad.com'
    || (referrer?.hostname === 'chrisawad.github.io' && /^\/Games-Dashboard(?:\/|$)/i.test(referrer.pathname))
    || (android && referrer?.protocol === 'android-app:' && !referrer.hostname.startsWith('org.chromium.webapk.'))) return true;
  const ua = navigator.userAgent;
  if ((appleMobile || android) && /FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|\bLine\/|LinkedInApp|GSA\/|Snapchat|TikTok|BytedanceWebview|Pinterest|Twitter for/i.test(ua)) return true;
  if (android && /;\s*wv\b|Version\/4\.0.*Chrome\//i.test(ua)) return true;
  return appleMobile && !sources.includes('tictactoe-app') && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua);
}

function installDirections(appleMobile: boolean, android: boolean, embedded: boolean) {
  const name = isSecureContext ? 'Tic Tac Toe' : '<a>Tic Tac Toe</a>';
  if (appleMobile) {
    const first = embedded
      ? 'Use <strong>Open in Safari</strong> in this window’s menu, or copy the game link below and open it in Safari. Tap <strong>Share</strong>.'
      : 'Open ' + name + ' in Safari and tap <strong>Share</strong>.';
    return '<ol><li>' + first + '</li><li>Choose <strong>Add to Home Screen</strong>. Turn on <strong>Open as Web App</strong> if offered, then tap <strong>Add</strong>.</li></ol>';
  }
  if (android) {
    const first = embedded
      ? 'Choose <strong>Open in Chrome</strong> in this window’s menu, or copy the game link below and open it in Chrome.'
      : 'Open ' + name + ' in Chrome.';
    return '<ol><li>' + first + '</li><li>Tap Chrome’s <strong>⋮ menu</strong>, choose <strong>Install app</strong> or <strong>Add to Home screen</strong>, and follow the prompt.</li></ol>';
  }
  if (!isSecureContext) return '<p>To install from this preview, open <a>Tic Tac Toe over HTTPS</a>.</p>';
  if (/Macintosh/.test(navigator.userAgent) && /Version\/.*Safari\//.test(navigator.userAgent)) {
    return '<p>In Safari, choose <strong>File → Add to Dock</strong>, then select <strong>Add</strong>.</p>';
  }
  return '<p>Open Tic Tac Toe in Chrome or Edge and choose the <strong>install option</strong> in the address bar or browser menu.</p>';
}
