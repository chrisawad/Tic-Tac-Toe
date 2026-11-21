import { registerSW } from 'virtual:pwa-register';

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
  help: HTMLButtonElement,
  dialog: HTMLDialogElement,
  update: HTMLButtonElement,
  notify: (message: string) => void,
) {
  const nav = navigator as InstallNavigator;
  const display = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  const confirm = dialog.querySelector<HTMLButtonElement>('#install-confirm')!;
  const steps = dialog.querySelector<HTMLElement>('#install-steps')!;
  const storageKey = 'ttt:installed';
  let pending: NativeInstall | undefined;
  let installed = false;
  let checked = false;
  let offered = false;
  let related = false;
  let busy = false;
  let nativeFailed = false;
  const nativeAvailable = () => typeof nav.install === 'function' && !nativeFailed;
  const canInstall = () => isSecureContext && (nativeAvailable() || Boolean(pending));
  try { installed = localStorage.getItem(storageKey) === 'yes'; } catch { /* Private storage may be unavailable. */ }
  function remember(value: boolean) {
    installed = value;
    try {
      if (value) localStorage.setItem(storageKey, 'yes');
      else localStorage.removeItem(storageKey);
    } catch { /* In-memory detection still works. */ }
  }
  function offer() {
    offered = true;
    if (!dialog.open) dialog.showModal();
  }

  function reflect() {
    const standalone = installed || related || display.matches || nav.standalone === true;
    install.hidden = standalone || !canInstall();
    help.hidden = standalone || canInstall();
    confirm.hidden = !canInstall();
    steps.hidden = canInstall();
    if (standalone && dialog.open) dialog.close();
    else if (checked && !standalone && !offered) offer();
  }
  async function checkRelated() {
    if (!isSecureContext || !nav.getInstalledRelatedApps) return;
    try {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const manifest = new URL('manifest.webmanifest', base).href;
      related = (await nav.getInstalledRelatedApps()).some(app => app.platform === 'webapp' && (app.id === base.href || app.url === manifest));
      reflect();
    } catch { /* The browser’s installation help remains available. */ }
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (display.matches || nav.standalone) return;
    pending = event as NativeInstall;
    remember(false);
    related = false;
    reflect();
  });
  window.addEventListener('appinstalled', () => {
    remember(true);
    pending = undefined;
    reflect();
  });
  window.addEventListener('focus', () => { reflect(); void checkRelated(); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    installed = event.newValue === 'yes';
    reflect();
  });
  function displayChanged() {
    if (display.matches || nav.standalone) remember(true);
    reflect();
  }
  display.addEventListener('change', displayChanged);
  async function requestInstall() {
    if (busy || !canInstall()) return;
    offered = true;
    busy = true;
    if (dialog.open) dialog.close();
    install.setAttribute('aria-disabled', 'true');
    try {
      if (nativeAvailable()) {
        await nav.install!();
        remember(true);
      } else if (pending) {
        const event = pending;
        pending = undefined;
        await event.prompt();
        if ((await event.userChoice).outcome === 'accepted') remember(true);
        if (!installed) {
          notify('Installation canceled. You can install later.');
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        notify('Installation canceled. You can install later.');
      } else {
        nativeFailed = true;
        notify('Installation didn’t finish. You can also use your browser’s install menu.');
      }
    } finally {
      busy = false;
      install.removeAttribute('aria-disabled');
      const wasFocused = document.activeElement === install;
      reflect();
      if (wasFocused && install.hidden && !help.hidden) help.focus();
    }
  }
  steps.textContent = installSteps();
  install.addEventListener('click', requestInstall);
  confirm.addEventListener('click', requestInstall);
  help.addEventListener('click', offer);
  displayChanged();
  void checkRelated().then(() => { checked = true; reflect(); });
  const updateSW = registerSW({ onNeedRefresh() { update.hidden = false; } });
  update.addEventListener('click', () => void updateSW(true));
}

function installSteps() {
  if (!isSecureContext) return 'Open the HTTPS version of the game to install it.';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios
    ? 'In Safari, open Share, choose Add to Home Screen, and tap Add. Turn on Open as Web App if your version offers it.'
    : 'Open your browser’s menu and look for Install Tic Tac Toe, Add to Home Screen, or Add to Dock.';
}
