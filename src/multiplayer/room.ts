import { Peer, type DataConnection } from 'peerjs';
import { observeConnectionRoute, type ConnectionRoute } from './connection-route';
import { newRoomCode } from './invite';
import { defaultRtcConfig, relayConfiguration, trackConnectionSetup } from './rtc';

export type Seat = 0 | 1;
export type HostedRoom = { code: string; token?: string };
type RoomFailure = 'service' | 'host' | 'guest' | 'other-window';
type Fields = Record<string, unknown>;
const controlMessages = new Set(['hello', 'welcome', 'ping', 'leave']);

function isControlMessage(data: object) {
  return 'kind' in data && typeof data.kind === 'string' && controlMessages.has(data.kind);
}

export interface MultiplayerGame<Profile, Action extends object> {
  /** Unique across games using the same signaling service. Include the protocol version. */
  namespace: string;
  storageKey?: string;
  relayUrl?: string;
  isProfile: (value: unknown) => value is Profile;
  parseAction: (value: unknown) => Action | null;
  hello?: Fields;
  acceptGuest?: (host: Profile, guest: Profile, hello: Fields) => { profile: Profile; welcome?: Fields };
  acceptWelcome?: (guest: Profile, welcome: Fields) => Profile;
}

export interface RoomHandlers<Profile, Action> {
  waiting: (code: string, token: string) => void;
  connecting?: () => void;
  route?: (route: ConnectionRoute) => void;
  start: (players: [Profile, Profile], seat: Seat) => void;
  action: (action: Action) => void;
  failure: (message: string, reason?: RoomFailure) => void;
}

export const offlineMessage = 'This device appears to be offline. Reconnect to the internet and try again.';
const serviceFailure = 'This device couldn’t reach the room service. Check your internet connection and try again.';
const serviceLost = 'This device lost its connection to the room service. Check your internet connection and try again.';
const lostOpponent = 'Lost contact with your opponent. Check that both devices are online, then create a new room.';
export function openPeerRoom<Profile, Action extends object>(
  game: MultiplayerGame<Profile, Action>, profile: Profile, code: string | null,
  handlers: RoomHandlers<Profile, Action>, restored?: HostedRoom,
) {
  const prefix = game.namespace + '-';
  const host = code === null;
  const hostToken = host ? restored?.token ?? crypto.randomUUID() : undefined;
  let peer: Peer;
  let releaseHostLock: (() => void) | undefined;
  let channel: DataConnection | undefined;
  let countdown: number | undefined;
  let connectionLost: number | undefined;
  let heartbeat: number | undefined;
  let lastMessage = 0;
  let closed = false;
  let playing = false;
  let attempts = 0;
  const listeners = new AbortController();
  let rtcConfig = defaultRtcConfig;
  let relayUnavailable = false;
  let joinFailure = () => serviceFailure;

  const cancelTimeout = () => window.clearTimeout(countdown);
  function depart() {
    if (playing) transmit({ kind: 'leave' });
  }
  function close(graceful = false) {
    if (closed) return;
    if (graceful) depart();
    if (closed) return;
    closed = true;
    cancelTimeout();
    window.clearTimeout(connectionLost);
    window.clearInterval(heartbeat);
    listeners.abort();
    if (graceful && playing) window.setTimeout(() => peer.destroy(), 200);
    else peer?.destroy();
    releaseHostLock?.();
  }
  function fail(message: string, reason?: RoomFailure) {
    if (closed) return;
    close();
    handlers.failure(navigator.onLine === false ? offlineMessage : message, reason);
  }
  function failConnection() {
    if (playing) fail(lostOpponent);
    else if (host) fail(joinFailure(), 'guest');
    else fail(joinFailure(), !channel?.peerConnection?.remoteDescription || channel.open ? 'host' : undefined);
  }
  function timeLimit(onTimeout: () => void) {
    cancelTimeout();
    countdown = window.setTimeout(onTimeout, 16_000);
  }

  function useConnection(connection: DataConnection) {
    if (closed || channel) { connection.close(); return; }
    channel = connection;
    joinFailure = trackConnectionSetup(connection, host, listeners.signal, relayUnavailable);
    timeLimit(() => {
      const pc = connection.peerConnection;
      // A relay lookup can fail while ICE is still checking a usable direct route.
      if (!connection.open && pc.remoteDescription && ['new', 'checking', 'connected', 'completed'].includes(pc.iceConnectionState)) {
        countdown = window.setTimeout(failConnection, 24_000);
        handlers.connecting?.();
      } else {
        failConnection();
      }
    });
    connection.on('iceStateChanged', state => {
      window.clearTimeout(connectionLost);
      if (!closed && playing && state === 'disconnected') {
        connectionLost = window.setTimeout(() => fail(lostOpponent), 5000);
      }
    });
    connection.on('open', () => {
      if (!host && !closed) transmit({ ...game.hello, kind: 'hello', profile });
    });
    connection.on('data', data => {
      if (closed || !data || typeof data !== 'object') return;
      if (playing) {
        lastMessage = performance.now();
        if ('kind' in data && data.kind === 'leave') {
          fail('Your opponent left the room.');
          return;
        }
        if (isControlMessage(data)) return;
        const action = game.parseAction(data);
        if (action !== null) handlers.action(action);
        return;
      }
      const message = data as Fields;
      if (message.kind !== (host ? 'hello' : 'welcome') || !game.isProfile(message.profile)) return;
      const remote = message.profile;
      let players: [Profile, Profile];
      if (host) {
        const guest = game.acceptGuest?.(profile, remote, message);
        players = [profile, guest ? guest.profile : remote];
        if (!transmit({ ...guest?.welcome, kind: 'welcome', profile })) return;
      } else {
        players = [remote, game.acceptWelcome ? game.acceptWelcome(profile, message) : profile];
      }
      playing = true;
      cancelTimeout();
      lastMessage = performance.now();
      let refreshRoute: (() => Promise<void>) | undefined;
      heartbeat = window.setInterval(() => {
        if (performance.now() - lastMessage > 25_000) fail(lostOpponent);
        else {
          transmit({ kind: 'ping' });
          void refreshRoute?.();
        }
      }, 5_000);
      handlers.start(players, host ? 0 : 1);
      if (!closed && handlers.route) {
        refreshRoute = observeConnectionRoute(connection.peerConnection, listeners.signal, handlers.route);
      }
    });
    connection.on('close', failConnection);
    connection.on('error', failConnection);
  }

  function transmit(data: object) {
    if (closed || !channel?.open) return false;
    try {
      channel.send(data);
      return true;
    } catch {
      failConnection();
      return false;
    }
  }

  function register(roomCode: string) {
    attempts++;
    const registered = hostToken
      ? new Peer(prefix + roomCode, { token: hostToken, config: rtcConfig })
      : new Peer(prefix + 'guest-' + crypto.randomUUID(), { config: rtcConfig });
    peer = registered;
    timeLimit(() => fail('The room service didn’t respond in time. Check your internet connection and try again.', 'service'));
    registered.on('open', () => {
      if (closed || registered !== peer) return;
      cancelTimeout();
      if (hostToken) handlers.waiting(roomCode, hostToken);
      else useConnection(peer.connect(prefix + roomCode, { reliable: true, serialization: 'json' }));
    });
    if (host) registered.on('connection', useConnection);
    registered.on('error', error => {
      if (closed || registered !== peer || (playing && channel?.open)) return;
      if (host && !restored && error.type === 'unavailable-id' && attempts < 4) {
        register(newRoomCode());
        registered.destroy();
      } else if (error.type === 'peer-unavailable') {
        fail(host ? 'The joining player disconnected. Ask them to open the same invite again.'
          : `Room ${roomCode} couldn’t be found. Check the code and ask the host to return to the game, then tap Join room again.`, host ? 'guest' : 'host');
      } else if (error.type === 'browser-incompatible') {
        fail('This browser doesn’t support the connection used for online play. Open the game in an up-to-date browser.');
      } else if (error.type === 'unavailable-id') {
        if (restored) fail(`Room ${roomCode} is still in use. Return to the original game window, or create a new room and share its new invite.`);
        else fail('The room service couldn’t assign a unique ID. Try again to get a new one.');
      } else if (error.type === 'webrtc') {
        fail('The browser reported a WebRTC error while setting up the connection. Reopen the game in an up-to-date browser and try again.',
          host && channel ? 'guest' : undefined);
      } else if (error.type === 'invalid-key' || error.type === 'invalid-id') {
        fail('The room service rejected the registration. Refresh the game and try again.');
      } else if (error.type === 'server-error') {
        fail('The room service reported an error. Try again in a moment.', 'service');
      } else {
        fail(registered.open ? serviceLost : serviceFailure, 'service');
      }
    });
    registered.on('disconnected', () => {
      if (peer === registered && (!playing || !channel?.open)) fail(serviceLost, 'service');
    });
  }

  const roomCode = code ?? restored?.code ?? newRoomCode();
  async function prepareRoom() {
    cancelTimeout();
    const endpoint = game.relayUrl;
    if (endpoint) {
      const relay = await relayConfiguration(endpoint, listeners.signal);
      relayUnavailable = relay.unavailable;
      rtcConfig = relay.config;
    }
    if (!closed) {
      try { register(roomCode); }
      catch { fail('The browser couldn’t start the game connection. Refresh the game and try again.'); }
    }
  }
  if (hostToken && navigator.locks) {
    const held = new Promise<void>(resolve => { releaseHostLock = resolve; });
    // A page can resume before the browser finishes releasing its previous lock.
    countdown = window.setTimeout(() => {
      fail(`Room ${roomCode} is open in another game window on this device. Return there to use your original invite.`, 'other-window');
    }, 1000);
    void navigator.locks.request(prefix + hostToken, { signal: listeners.signal }, () => {
      if (closed) return;
      void prepareRoom();
      return held;
    }).catch(() => fail('This browser couldn’t open the room. Reopen the game and try again.'));
  } else {
    void prepareRoom();
  }
  // A cached page can resume in the same match. Only an actual departure sends leave.
  window.addEventListener('pagehide', event => { if (!event.persisted) depart(); }, { signal: listeners.signal });
  return {
    close: () => close(true),
    send: (action: Action) => !closed && playing && !isControlMessage(action) && transmit(action),
  };
}
