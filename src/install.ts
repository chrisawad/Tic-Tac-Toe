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
  help: HTMLButtonElement,
  dialog: HTMLDialogElement,
  update: HTMLButtonElement,
  notify: (message: string) => void,
  { offerOnLaunch, beforeUpdateReload }: { offerOnLaunch: () => boolean; beforeUpdateReload: () => void },
) {
  const nav = navigator as InstallNavigator;
  const display = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  const confirm = dialog.querySelector<HTMLButtonElement>('#install-confirm')!;
  const steps = dialog.querySelector<HTMLElement>('#install-steps')!;
  const title = dialog.querySelector<HTMLElement>('#install-title')!;
  const dismiss = dialog.querySelector<HTMLButtonElement>('#install-dismiss')!;
  const benefit = dialog.querySelector<HTMLElement>('#install-benefit')!;
  const copyStatus = dialog.querySelector<HTMLElement>('#install-copy-status')!;
  const sources = new URLSearchParams(location.hash.slice(1)).getAll('from');
  const dashboardLaunch = sources.includes('games-dashboard');
  // A Dashboard window can report the same display mode as this game's own window.
  const gameLaunch = window === window.top && sources.includes('tictactoe-app') && !dashboardLaunch;
  const instructions = installInstructions();
  const showDirectionsOnEntry = dashboardLaunch || instructions.mobile || window !== window.top;
  const updateDialog = document.querySelector<HTMLDialogElement>('#update-dialog')!;
  let pending: NativeInstall | undefined;
  let installed = false;
  let readyToOffer = false;
  let offered = false;
  let readingHelp = false;
  let related = false;
  let busy = false;
  let nativeFailed = false;
  const nativeAvailable = () => typeof nav.install === 'function' && !nativeFailed;
  const canInstall = () => isSecureContext && (nativeAvailable() || Boolean(pending));
  const inGameWindow = () => gameLaunch && (display.matches || nav.standalone === true);
  const showDirections = () => readingHelp || showDirectionsOnEntry || !canInstall();
  function openDialog(manual: boolean) {
    offered = true;
    readingHelp = manual;
    title.textContent = manual ? 'How to install' : 'Install Tic Tac Toe';
    dismiss.textContent = manual ? 'Done' : 'Not now';
    benefit.hidden = manual;
    copyStatus.textContent = '';
    steps.hidden = !showDirections();
    if (!dialog.open) dialog.showModal();
  }

  function reflect() {
    const standalone = inGameWindow();
    const alreadyInstalled = standalone || installed || related;
    install.hidden = alreadyInstalled || !canInstall();
    help.hidden = standalone;
    confirm.hidden = install.hidden;
    steps.hidden = !showDirections();
    if (alreadyInstalled && dialog.open && !readingHelp) dialog.close();
    else if (readyToOffer && !alreadyInstalled && !offered && !updateDialog.open && offerOnLaunch()) openDialog(false);
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
    } catch { /* The browser’s installation help remains available. */ }
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (inGameWindow()) return;
    pending = event as NativeInstall;
    reflect();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    pending = undefined;
    reflect();
  });
  window.addEventListener('focus', () => { reflect(); void checkRelated(); });
  display.addEventListener('change', reflect);
  updateDialog.addEventListener('close', reflect);
  async function requestInstall() {
    if (busy || !canInstall()) return;
    offered = true;
    busy = true;
    if (dialog.open) dialog.close();
    install.setAttribute('aria-disabled', 'true');
    try {
      if (nativeAvailable()) {
        await nav.install!();
        installed = true;
      } else if (pending) {
        const event = pending;
        pending = undefined;
        await event.prompt();
        if ((await event.userChoice).outcome === 'accepted') installed = true;
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
  if (!isSecureContext) instructions.steps.unshift('Copy the secure game link below and open it in your browser.');
  dialog.querySelector('#install-directions')!.replaceChildren(...instructions.steps.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  dialog.querySelector<HTMLElement>('#install-launch')!.textContent = instructions.launch;
  dialog.querySelector<HTMLElement>('#install-copy')!.hidden = isSecureContext && !instructions.copyLink;
  install.addEventListener('click', requestInstall);
  confirm.addEventListener('click', requestInstall);
  help.addEventListener('click', () => openDialog(true));
  reflect();
  function enableLaunchOffer() {
    readyToOffer = true;
    reflect();
  }
  // Give a fast positive result time to arrive. Embedded browsers may never settle this call.
  const deadline = window.setTimeout(enableLaunchOffer, 400);
  void checkRelated().then(() => { clearTimeout(deadline); enableLaunchOffer(); });
  setupUpdates(update, dialog, beforeUpdateReload);
}

function installInstructions() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return {
    mobile: true,
    steps: [
      'If the game opened inside another app, open its ⋮ menu and tap Open in Chrome or Open in browser. Choose Chrome if asked.',
      'If that option is missing, copy the game link below, open Chrome, and paste it into the address bar.',
      'In Chrome, tap ⋮ and choose Install app or Add to Home screen. Some versions show Install and create shortcut. Follow the prompts.',
    ],
    launch: 'Already installed? Swipe up on your Android home screen to open the app drawer. Search for Tic Tac Toe and tap its icon.',
    copyLink: true,
  };
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return {
    mobile: true,
    steps: [
      'Open the game in Safari. If you’re inside another app, copy the game link below and paste it into Safari.',
      'Tap Share, then Add to Home Screen. Turn on Open as Web App if available, then tap Add.',
    ],
    launch: 'Already installed? Tap Tic Tac Toe on your Home Screen or search for it in the App Library.',
    copyLink: true,
  };
  if (/Mac/.test(navigator.platform) && /Safari\//.test(ua) && !/Chrom(?:e|ium)\//.test(ua)) return {
    mobile: false,
    steps: ['In Safari, open the File menu, choose Add to Dock, then click Add.'],
    launch: 'Already installed? Open Tic Tac Toe from the Dock or search for it in Spotlight.',
    copyLink: false,
  };
  return {
    mobile: false,
    steps: ['Open the game in Chrome or Edge. Choose the install icon in the address bar, or open the browser menu and look for the option to install this page as an app.'],
    launch: 'Already installed? Search for Tic Tac Toe in your computer’s apps and open it.',
    copyLink: true,
  };
}
