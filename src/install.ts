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
  helpLabel: HTMLElement,
  update: HTMLButtonElement,
  notify: (message: string) => void,
) {
  const nav = navigator as InstallNavigator;
  const display = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  let pending: NativeInstall | undefined;
  let installed = false;
  let related = false;
  let busy = false;
  const canInstall = () => isSecureContext && (typeof nav.install === 'function' || Boolean(pending));

  function reflect() {
    const standalone = installed || related || display.matches || nav.standalone === true;
    install.hidden = standalone || !canInstall();
    help.hidden = standalone || canInstall();
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
    pending = event as NativeInstall;
    installed = related = false;
    reflect();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    pending = undefined;
    reflect();
  });
  window.addEventListener('focus', () => { reflect(); void checkRelated(); });
  display.addEventListener('change', reflect);
  install.addEventListener('click', async () => {
    if (busy || !canInstall()) return;
    busy = true;
    install.setAttribute('aria-disabled', 'true');
    try {
      if (typeof nav.install === 'function') {
        await nav.install();
        installed = true;
      } else if (pending) {
        const event = pending;
        pending = undefined;
        await event.prompt();
        installed ||= (await event.userChoice).outcome === 'accepted';
        if (!installed) {
          helpLabel.textContent = 'Install help';
          notify('Installation canceled. You can install later.');
        }
      }
    } catch {
      notify('Installation didn’t finish. You can also use your browser’s install menu.');
    } finally {
      busy = false;
      install.removeAttribute('aria-disabled');
      const wasFocused = document.activeElement === install;
      reflect();
      if (wasFocused && install.hidden && !help.hidden) help.focus();
    }
  });
  reflect();
  void checkRelated();
  const updateSW = registerSW({ onNeedRefresh() { update.hidden = false; } });
  update.addEventListener('click', () => void updateSW(true));
}

export function installSteps() {
  if (!isSecureContext) return 'Open the HTTPS version of the game to install it.';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios
    ? 'In Safari, open Share, choose Add to Home Screen, and tap Add. Turn on Open as Web App if your version offers it.'
    : 'Open your browser’s menu and look for Install Tic Tac Toe, Add to Home Screen, or Add to Dock.';
}
