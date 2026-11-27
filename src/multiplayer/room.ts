import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import { observeConnectionRoute, type ConnectionRoute } from './connection-route';
import { newRoomCode, type createRoomCodes } from './invite';
import { trackConnectionSetup } from './rtc';
import { receiveMatchRelay, relayFailureMessage, requestMatchRelay } from './relay-admission';
import { prepareNetwork } from './transport';

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
  codes?: ReturnType<typeof createRoomCodes>;
  relayUrl?: string;
  peerOptions?: Pick<PeerOptions, 'host' | 'port' | 'secure' | 'path'>;
  isProfile: (value: unknown) => value is Profile;
  parseAction: (value: unknown) => Action | null;
  hello?: Fields;
  acceptGuest?: (host: Profile, guest: Profile, hello: Fields) => { profile: Profile; welcome?: Fields };
  acceptWelcome?: (guest: Profile, welcome: Fields) => Profile;
}

export interface RoomHandlers<Profile, Action> {
  waiting: (code: string, token: string) => void;
  status?: (message: string) => void;
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
  const generateCode = game.codes?.newRoomCode ?? newRoomCode;
  const host = code === null;
  const hostToken = host ? restored?.token ?? crypto.randomUUID() : undefined;
  let peer: Peer;
  let releaseHostLock: (() => void) | undefined;
  let channel: DataConnection | undefined;
  let channelEvents: AbortController | undefined;
  let countdown: number | undefined;
  let connectionLost: number | undefined;
  let heartbeat: number | undefined;
  let lastMessage = 0;
  let closed = false;
  let playing = false;
  let attempts = 0;
  const listeners = new AbortController();
  const network = prepareNetwork(game.relayUrl);
  let relay: { config: RTCConfiguration; match: string } | undefined;
  let retriedRelay = false;
  let sentHello = false;
  let hasAnswer = () => false;
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
    channelEvents?.abort();
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
    if (closed || !channel) return;
    if (playing) { fail(lostOpponent); return; }
    if (peer.open && !peer.disconnected && navigator.onLine) {
      if (host) {
        discardChannel();
        handlers.status?.('Room is still open. Waiting for your friend to reconnect…');
        return;
      }
      if (hasAnswer() && !sentHello && game.relayUrl && !retriedRelay) {
        retriedRelay = true;
        discardChannel();
        // The new channel uses the same guest registration and fresh ICE checks.
        void requestMatchRelay(peer, prefix + code, game.relayUrl, game.namespace, 'join', listeners.signal)
          .then(approved => { if (!closed) { relay = approved; connectToHost(); } })
          .catch(() => { if (!closed) fail(relayFailureMessage); });
        handlers.status?.('Room found. Retrying through the backup relay…');
        return;
      }
    }
    const waitingForHost = !retriedRelay && (!hasAnswer() || sentHello);
    const reason = host ? 'guest' : waitingForHost ? 'host' : undefined;
    fail(joinFailure(), reason);
  }
  function discardChannel() {
    const previous = channel;
    channel = undefined;
    cancelTimeout();
    window.clearTimeout(connectionLost);
    channelEvents?.abort();
    previous?.close();
  }
  function connectToHost() {
    if (closed || !code) return;
    try {
      if (relay) peer.options.config = relay.config;
      useConnection(peer.connect(prefix + code, { reliable: true, serialization: 'json',
        metadata: { app: game.namespace, type: 'join', ...(relay && { relayMatch: relay.match }) } }));
    } catch { fail('The browser couldn’t start the game connection. Try joining again.'); }
    finally { peer.options.config = network.config; }
  }
  function timeLimit(onTimeout: () => void) {
    cancelTimeout();
    countdown = window.setTimeout(onTimeout, 16_000);
  }

  function useConnection(connection: DataConnection) {
    if (host && !closed && !playing && channel &&
        (!channel.peerConnection || channel.peer === connection.peer)) discardChannel();
    if (closed || channel) { connection.close(); return; }
    channel = connection;
    const pc = connection.peerConnection;
    const current = () => !closed && channel === connection;
    hasAnswer = () => Boolean(pc.remoteDescription);
    sentHello = false;
    channelEvents = new AbortController();
    joinFailure = trackConnectionSetup(connection, host, channelEvents.signal);
    timeLimit(() => {
      if (!current()) return;
      // A relay lookup can fail while ICE is still checking a usable direct route.
      if (connection.peerConnection && !connection.open && pc.remoteDescription && ['new', 'checking', 'connected', 'completed'].includes(pc.iceConnectionState)) {
        countdown = window.setTimeout(failConnection, 24_000);
        handlers.status?.('Room found. Still connecting the devices… Keep both games on screen.');
      } else {
        failConnection();
      }
    });
    connection.on('iceStateChanged', state => {
      if (!current()) return;
      window.clearTimeout(connectionLost);
      if (!closed && playing && state === 'disconnected') {
        connectionLost = window.setTimeout(() => fail(lostOpponent), 5000);
      }
    });
    connection.on('open', () => {
      if (!host && current()) sentHello = transmit({ ...game.hello, kind: 'hello', profile });
    });
    connection.on('data', data => {
      if (!current() || !data || typeof data !== 'object') return;
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
    const ended = () => { if (current()) failConnection(); };
    connection.on('close', ended);
    connection.on('error', ended);
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
    const options = { ...game.peerOptions, config: network.config };
    const registered = hostToken
      ? new Peer(prefix + roomCode, { ...options, token: hostToken })
      : new Peer(prefix + 'guest-' + crypto.randomUUID(), options);
    peer = registered;
    timeLimit(() => fail('The room service didn’t respond in time. Check your internet connection and try again.', 'service'));
    registered.on('open', () => {
      if (closed || registered !== peer) return;
      cancelTimeout();
      if (hostToken) handlers.waiting(roomCode, hostToken);
      else connectToHost();
    });
    registered.on('connection', connection => {
      if (receiveMatchRelay(registered, connection, game.relayUrl, game.namespace, 'join', listeners.signal,
        () => host && !closed && !playing && peer === registered ? '' : undefined)) return;
      if (host) useConnection(connection);
      else connection.close();
    });
    registered.on('error', error => {
      if (closed || registered !== peer || (playing && channel?.open)) return;
      if (host && !restored && error.type === 'unavailable-id' && attempts < 4) {
        register(generateCode());
        registered.destroy();
      } else if (error.type === 'peer-unavailable') {
        // An expired reply to a departed guest does not invalidate the host's registration.
        if (!host) fail(`Room ${roomCode} couldn’t be found. Check the code and ask the host to return to the game, then tap Join room again.`, 'host');
      } else if (error.type === 'browser-incompatible') {
        fail('This browser doesn’t support the connection used for online play. Open the game in an up-to-date browser.');
      } else if (error.type === 'unavailable-id') {
        if (restored) fail(`Room ${roomCode} is still in use. Return to the original game window, or create a new room and share its new invite.`);
        else fail('The room service couldn’t assign a unique ID. Try again to get a new one.');
      } else if (error.type === 'webrtc') {
        // Peer-level candidate errors can arrive from an earlier negotiation. The
        // current channel has its own error, close and timeout handlers.
        if (!host && !channel && !retriedRelay) fail('The browser couldn’t start the game connection. Try joining again.');
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

  const roomCode = code ?? restored?.code ?? generateCode();
  function prepareRoom() {
    cancelTimeout();
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
