import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { verifyRelayPlayer } from "./turnstile";
import { relayIceConfiguration } from "./rtc";

type Purpose = "find" | "join";
type Fields = Record<string, string>;
type Grant = { peer: string; purpose: Purpose; seat: string; config: RTCConfiguration };
const grants = new WeakMap<Peer, Map<string, Grant>>();
const pending = new WeakMap<Peer, Set<string>>();
const label = "relay-admission-v1";
const verificationWindow = 120_000;
const digestPattern = /^[a-f0-9]{64}$/;
const failure = () => new Error("The backup relay could not verify this match.");
export const relayFailureMessage = "Couldn’t get temporary access to the backup relay. Keep both games open, update both games if available, and try joining again.";

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function post(base: string, path: string, body: Fields, signal: AbortSignal) {
  const url = new URL(base, location.href);
  url.pathname = url.pathname.replace(/\/$/, "") + "/v1/" + path;
  url.hash = url.search = "";
  return fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(path === "credentials" ? 18_000 : 6000)]),
  });
}

async function result(response: Response) {
  if (!response.ok) throw failure();
  return response.json();
}

async function redeem(base: string, match: string, session: string, sitekey: string, signal: AbortSignal) {
  if (!session || !match || typeof sitekey !== "string" || !sitekey) throw failure();
  const seat = { match, session };
  const turnstileToken = await verifyRelayPlayer(sitekey, await digest(match + ":" + session), signal);
  signal.throwIfAborted();
  let issued = await post(base, "ticket", seat, signal);
  // The host can reach the Worker before the other browser claims its seat.
  while (issued.status === 409) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    signal.throwIfAborted();
    issued = await post(base, "ticket", seat, signal);
  }
  const { ticket } = await result(issued);
  if (typeof ticket !== "string" || !ticket) throw failure();
  const { iceServers } = await result(await post(base, "credentials", { ...seat, ticket, turnstileToken }, signal));
  return relayIceConfiguration(iceServers);
}

// PeerJS delivers offer metadata through signaling, before ICE or the data channel opens.
function notify(peer: Peer, target: string, metadata: Fields) {
  const channel = peer.connect(target, { label, serialization: "json", metadata });
  channel.on("error", () => {});
  setTimeout(() => channel.close(), 6000);
}

function nextReply(peer: Peer, target: string, game: string, commitment: string, phase: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { peer.off("connection", listen); signal.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(signal.reason); };
    function listen(ch: DataConnection) {
      const m = ch.metadata;
      if (ch.label !== label || ch.peer !== target || m?.game !== game || m?.commitment !== commitment) return;
      if (m.phase === "denied") { done(); reject(failure()); }
      else if (m.phase === phase && typeof m.match === "string") { done(); resolve(m.match); }
    }
    peer.on("connection", listen);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function requestMatchRelay(peer: Peer, target: string, base: string, game: string, purpose: Purpose,
  lifetime: AbortSignal, seatSecret = "") {
  const exchange = new AbortController();
  const signal = AbortSignal.any([lifetime, exchange.signal, AbortSignal.timeout(verificationWindow)]);
  const secret = crypto.randomUUID();
  const commitment = await digest(secret);
  const proof = seatSecret ? await digest(commitment + ":" + seatSecret) : "";
  try {
    const [match] = await Promise.all([
      nextReply(peer, target, game, commitment, "offer", AbortSignal.any([signal, AbortSignal.timeout(25000)])),
      Promise.resolve().then(() => notify(peer, target, { phase: "request", game, purpose, commitment, proof })),
    ]);
    const [readyMatch, config] = await Promise.all([
      nextReply(peer, target, game, commitment, "ready", signal),
      (async () => {
        const { session, sitekey } = await result(await post(base, "join", { match, secret }, signal));
        return redeem(base, match, session, sitekey, signal);
      })(),
    ]);
    if (readyMatch !== match) throw failure();
    return { config, match };
  } finally { exchange.abort(); }
}

// Call before ordinary game/queue connection handlers. A stored seat requires its
// existing reconnect proof; a waiting room can admit the first guest.
export function receiveMatchRelay(peer: Peer, ch: DataConnection, base: string | undefined, game: string,
  purpose: Purpose, lifetime: AbortSignal, seat: () => string | undefined): boolean {
  const m = ch.metadata;
  if (ch.label !== label) {
    if (m?.relayMatch === undefined) return false;
    const grant = grants.get(peer)?.get(m.relayMatch);
    if (grant?.peer === ch.peer && grant.purpose === purpose && m.app === game && m.type === purpose && seat() === grant.seat) {
      grants.get(peer)!.delete(m.relayMatch);
      // The inbound offer is still applying its remote SDP. Set ICE on just this
      // connection synchronously, before PeerJS creates the answer.
      try { ch.peerConnection.setConfiguration(grant.config); return false; } catch {}
    }
    ch.close();
    return true;
  }
  ch.on("error", () => {});
  setTimeout(() => ch.close(), 6000);
  if (!base || m?.phase !== "request" || m.game !== game || m.purpose !== purpose ||
      typeof m.commitment !== "string" || !digestPattern.test(m.commitment) || lifetime.aborted) return true;
  const expected = seat();
  const active = pending.get(peer) ?? new Set<string>();
  if (expected === undefined || active.has(ch.peer) || active.size >= 4) return true;
  pending.set(peer, active);
  active.add(ch.peer);
  const { commitment } = m;
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(verificationWindow)]);
  const reply = (phase: string, match: string) => notify(peer, ch.peer, { phase, game, commitment, match });
  void (async () => {
    if (expected && await digest(commitment + ":" + expected) !== m.proof) throw failure();
    const { match, session, sitekey } = await result(await post(base, "matches", {
      game, hostPeer: peer.id, guestPeer: ch.peer, guestCommitment: commitment,
    }, signal));
    if (typeof match !== "string" || !match || typeof session !== "string" || !session) throw failure();
    reply("offer", match);
    const config = await redeem(base, match, session, sitekey, signal);
    signal.throwIfAborted();
    if (seat() !== expected) throw failure();
    const available = grants.get(peer) ?? new Map<string, Grant>();
    grants.set(peer, available);
    available.set(match, { peer: ch.peer, purpose, seat: expected, config });
    setTimeout(() => available.delete(match), verificationWindow);
    reply("ready", match);
  })().catch(() => {
    if (!lifetime.aborted && peer.open) { try { reply("denied", ""); } catch {} }
  }).finally(() => active.delete(ch.peer));
  return true;
}
