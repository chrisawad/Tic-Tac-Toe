import { registerSW } from 'virtual:pwa-register';

export function setupUpdates(button: HTMLButtonElement, installDialog: HTMLDialogElement, beforeReload: () => void) {
  const dialog = document.querySelector<HTMLDialogElement>('#update-dialog')!;
  const confirm = dialog.querySelector<HTMLButtonElement>('#update-confirm')!;
  const detail = dialog.querySelector<HTMLElement>('#update-detail')!;
  const description = detail.textContent;
  let registration: ServiceWorkerRegistration | undefined;
  let pending: ServiceWorker | null = null;
  let applying = false;
  let reloading = false;
  let lastCheck = Date.now();

  function offer() {
    if (!pending || document.hidden || dialog.open) return;
    if (installDialog.open) installDialog.close();
    dialog.showModal();
  }

  function checkWaiting() {
    const worker = registration?.waiting;
    if (!registration?.active || !worker || worker === pending) return;
    pending = worker;
    button.hidden = false;
    detail.textContent = description;
    offer();
  }

  function reload() {
    if (!applying || reloading) return;
    reloading = true;
    beforeReload();
    window.location.reload();
  }

  function checkForUpdate() {
    if (!registration || document.hidden || !navigator.onLine || registration.installing || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    void registration.update().catch(() => { /* Try again on the next foreground check. */ });
  }

  const activate = registerSW({
    onRegisteredSW(_url, value) {
      if (!value) return;
      registration = value;
      const watchInstall = () => value.installing?.addEventListener('statechange', checkWaiting);
      value.addEventListener('updatefound', watchInstall);
      watchInstall();
      checkWaiting();
      window.setInterval(checkForUpdate, 5 * 60_000);
    },
    onNeedRefresh: checkWaiting,
    onNeedReload: reload,
  });

  async function apply() {
    if (applying || !pending) return;
    applying = true;
    confirm.disabled = true;
    const worker = registration?.waiting;
    // Another game window may already have activated the waiting update.
    if (!worker) { reload(); return; }
    const listeners = new AbortController();
    function retry() {
      window.clearTimeout(timeout);
      listeners.abort();
      if (reloading) return;
      applying = false;
      confirm.disabled = false;
      checkWaiting();
      detail.textContent = 'The update hasn’t finished. Try Update now again.';
    }
    const timeout = window.setTimeout(retry, 15_000);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') reload();
      if (worker.state === 'redundant') retry();
    }, { signal: listeners.signal });
    try { await activate(true); }
    catch { retry(); }
  }

  function onReturn() {
    if (document.hidden) return;
    checkWaiting();
    offer();
    checkForUpdate();
  }
  button.addEventListener('click', offer);
  confirm.addEventListener('click', () => void apply());
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('online', checkForUpdate);
}
