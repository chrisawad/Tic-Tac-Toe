import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { NoHostReply, RoomError } from "./feedback";
import { defaultRtcConfig, directRtcConfig, trackConnectionSetup } from "./rtc";
import { relayFailureMessage, requestMatchRelay } from "./relay-admission";

export function prepareNetwork(endpoint?: string) {
  return { config: endpoint ? directRtcConfig : defaultRtcConfig, endpoint };
}
export type RoomNetwork = ReturnType<typeof prepareNetwork>;

// Installed copies can share a saved lobby. Only its owning window may reuse its registration token.
export async function holdHostLock(namespace: string, token: string): Promise<() => void> {
  if (!navigator.locks) return () => {};
  const request = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => request.abort(), 1000);
    void navigator.locks.request(namespace + "-" + token, { signal: request.signal }, () => {
      clearTimeout(timeout);
      resolve(release);
      return held;
    }).catch(() => {
      clearTimeout(timeout);
      reject(new RoomError("This room is open in another game window. Return to that window or create a new room."));
    });
  });
}

type Handshake<T> = {
  seatSecret?: string;
  open?: (channel: DataConnection) => void;
  receive: (data: unknown) => T | undefined;
};
class RetryWithRelay extends RoomError {}

// Both matchmaking and joining supply their own acceptance handshake.
// A retry gets fresh ICE checks while keeping the same peer ID and seat ticket.
export async function connectRoom<T>(
  peer: Peer, target: string, protocol: string, type: "find" | "join", network: RoomNetwork,
  signal: AbortSignal, handshake: Handshake<T>, status: (message: string) => void,
) {
  function attempt(relay?: { config: RTCConfiguration; match: string }): Promise<{ channel: DataConnection; reply: T }> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const original = peer.options.config;
      let ch: DataConnection;
      try {
        if (relay) peer.options.config = relay.config;
        ch = peer.connect(target, {
          reliable: true, serialization: "json", metadata: { app: protocol, type, ...(relay && { relayMatch: relay.match }) },
        });
      } finally {
        // PeerJS constructs the RTCPeerConnection inside connect().
        peer.options.config = original;
      }
      const events = new AbortController();
      const pc = ch.peerConnection;
      const explain = trackConnectionSetup(ch, false, events.signal);
      let answered = !!pc.remoteDescription;
      let opened = false;
      let settled = false;
      let timer = window.setTimeout(() => {
        if (answered && !opened && ["new", "checking", "connected", "completed"].includes(pc.iceConnectionState)) {
          status("Room found. Still connecting the devices… Keep both games on screen.");
          timer = window.setTimeout(connectionFailed, 24000);
        } else connectionFailed();
      }, 16000);

      function finish() {
        settled = true;
        clearTimeout(timer);
        events.abort();
        signal.removeEventListener("abort", canceled);
        peer.off("error", peerError);
        ch.off("open", onOpen);
        ch.off("data", onData);
        ch.off("close", connectionFailed);
        ch.off("error", connectionFailed);
      }
      function fail(error: unknown) {
        if (settled) return;
        finish();
        ch.close();
        reject(error);
      }
      function connectionFailed() {
        if (settled) return;
        answered ||= !!pc.remoteDescription;
        if (answered && !opened && network.endpoint && !relay) fail(new RetryWithRelay(explain()));
        else fail(answered || opened ? new RoomError(explain()) : new NoHostReply(explain()));
      }
      function canceled() { fail(signal.reason); }
      function peerError(error: Error & { type?: string }) {
        if (error.type !== "webrtc") fail(error);
      }
      function onOpen() {
        opened = true;
        try { handshake.open?.(ch); } catch (error) { fail(error); }
      }
      function onData(data: unknown) {
        try {
          const reply = handshake.receive(data);
          if (reply === undefined || settled) return;
          finish();
          resolve({ channel: ch, reply });
        } catch (error) { fail(error); }
      }
      pc.addEventListener("signalingstatechange", () => { answered ||= !!pc.remoteDescription; }, { signal: events.signal });
      pc.addEventListener("iceconnectionstatechange", () => {
        answered ||= !!pc.remoteDescription;
        if (pc.iceConnectionState === "failed") connectionFailed();
      }, { signal: events.signal });
      signal.addEventListener("abort", canceled, { once: true });
      peer.on("error", peerError);
      ch.on("open", onOpen);
      ch.on("data", onData);
      ch.on("close", connectionFailed);
      ch.on("error", connectionFailed);
    });
  }
  try { return await attempt(); }
  catch (error) {
    if (!(error instanceof RetryWithRelay) || signal.aborted) throw error;
    status("Room found. Retrying through the backup relay…");
    let relay;
    try { relay = await requestMatchRelay(peer, target, network.endpoint!, protocol, type, signal, handshake.seatSecret); }
    catch { signal.throwIfAborted(); throw new RoomError(relayFailureMessage); }
    return attempt(relay);
  }
}
