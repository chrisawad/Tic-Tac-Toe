type WidgetOptions = {
  sitekey: string;
  action: string;
  cData: string;
  size: "flexible";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
};
type Turnstile = {
  render(container: HTMLElement, options: WidgetOptions): string;
  remove(widget: string): void;
};
let loading: Promise<Turnstile> | undefined;
let verifying = false;

function loadTurnstile() {
  if (loading) return loading;
  loading = new Promise<Turnstile>((resolve, reject) => {
    const host = window as Window & { turnstile?: Turnstile; onGameRelayTurnstileReady?: () => void };
    const script = document.createElement("script");
    const fail = () => {
      clearTimeout(timer);
      delete host.onGameRelayTurnstileReady;
      script.onerror = null;
      script.remove();
      reject(new Error("Could not load player verification."));
    };
    const timer = window.setTimeout(fail, 15000);
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onGameRelayTurnstileReady";
    script.async = true;
    script.onerror = fail;
    host.onGameRelayTurnstileReady = () => {
      if (!host.turnstile) { fail(); return; }
      clearTimeout(timer);
      script.onerror = null;
      delete host.onGameRelayTurnstileReady;
      resolve(host.turnstile);
    };
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

export async function verifyRelayPlayer(sitekey: string, binding: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!sitekey || verifying) throw new Error("Player verification unavailable.");
  verifying = true;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "relay-verification-title");
  dialog.innerHTML = '<h2 id="relay-verification-title">Verify to connect</h2><p>Your devices need a backup relay. Complete the check to connect.</p><div></div><form method="dialog"><button type="submit">Cancel</button></form>';
  const events = new AbortController();
  let api: Turnstile | undefined;
  let widget: string | undefined;
  try {
    document.body.append(dialog);
    dialog.showModal();
    return await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error("Player verification did not finish."));
      dialog.addEventListener("close", fail, { signal: events.signal });
      signal.addEventListener("abort", fail, { signal: events.signal });
      void loadTurnstile().then(loaded => {
        if (events.signal.aborted || signal.aborted || !dialog.open) return;
        api = loaded;
        widget = api.render(dialog.querySelector("div")!, {
          sitekey, action: "game_relay", cData: binding, size: "flexible",
          callback: resolve, "error-callback": fail, "expired-callback": fail, "timeout-callback": fail,
        });
      }).catch(fail);
    });
  } finally {
    events.abort();
    try { if (widget !== undefined) api?.remove(widget); }
    finally { dialog.close(); dialog.remove(); verifying = false; }
  }
}
