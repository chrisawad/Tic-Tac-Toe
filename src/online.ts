import { Peer, type DataConnection } from 'peerjs';
import { createMatch, isPlayer, move, nextRound, palette, type Color, type Match, type Player, type PlayerIndex } from './game';

const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const prefix = 'chrisawad-tic-tac-toe-v1-';
export const isRoomCode = (value: string) => /^[A-HJ-NP-Z2-9]{5}$/.test(value);

function newCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), value => letters[value % letters.length]).join('');
}

export function assignGuestColor(host: Color, guest: Color, random = Math.random): Color {
  if (guest !== host) return guest;
  const available = (Object.keys(palette) as Color[]).filter(color => color !== host);
  return available[Math.floor(random() * available.length)];
}

export type RoundAction =
  | { kind: 'move'; round: number; ply: number; cell: number }
  | { kind: 'ready'; round: number };

export function roundAction(data: unknown): RoundAction | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as RoundAction;
  if (!Number.isSafeInteger(message.round)) return null;
  if (message.kind === 'ready') return message;
  if (message.kind === 'move' && Number.isInteger(message.ply) && Number.isInteger(message.cell)) return message;
  return null;
}

export function applyRoomMove(match: Match, actor: PlayerIndex, action: Extract<RoundAction, { kind: 'move' }>) {
  return action.round === match.round && action.ply === match.moves.length ? move(match, action.cell, actor) : null;
}

export function readyForRematch(match: Match, ready: [boolean, boolean], actor: PlayerIndex, round: number) {
  if (round !== match.round) return match;
  const next = nextRound(match);
  if (match === next) return match;
  ready[actor] = true;
  return ready.every(Boolean) ? next : match;
}

export type HostedRoom = { code: string; token?: string };
type RoomFailure = 'service' | 'host' | 'guest' | 'other-window';

type Handlers = {
  waiting: (code: string, token: string) => void;
  start: (match: Match, index: PlayerIndex) => void;
  action: (action: RoundAction) => void;
  failure: (message: string, reason?: RoomFailure) => void;
};

export const offlineMessage = 'This device appears to be offline. Reconnect to the internet and try again.';
const serviceFailure = 'This device couldn’t reach the room service. Check your internet connection and try again.';
const serviceLost = 'This device lost its connection to the room service. Check your internet connection and try again.';
const lostOpponent = 'Lost contact with your opponent. Check that both devices are online, then create a new room.';

function trackConnectionSetup(connection: DataConnection, host: boolean, signal: AbortSignal) {
  const pc = connection.peerConnection;
  let opened = false;
  let gatheredRelay = false;
  let relayIssue = '';
  connection.on('open', () => { opened = true; });
  pc.addEventListener('icecandidate', event => {
    if (event.candidate?.type === 'relay') gatheredRelay = true;
  }, { signal });
  pc.addEventListener('icecandidateerror', event => {
    if (!/^turns?:/i.test(event.url) || event.errorCode !== 701) return;
    // 701 covers reachability. Only some browsers identify a DNS failure.
    if (/host lookup|dns|name resolution/i.test(event.errorText)) {
      relayIssue = 'This device couldn’t look up a backup relay’s address.';
    } else if (!relayIssue) {
      relayIssue = 'This device couldn’t reach a backup relay.';
    }
  }, { signal });
  return () => {
    if (opened) return 'The devices connected, but game setup didn’t finish. Return to the game on both devices and try joining again.';
    if (!host && !pc.remoteDescription) return 'No reply arrived from the host. Ask them to keep the room open and share their current code.';
    if (relayIssue && !gatheredRelay) return `Room found. ${relayIssue} Try the same home Wi-Fi or switch networks, then try joining again.`;
    return 'Room found, but the devices couldn’t establish a game connection. Try the same home Wi-Fi or switch networks, then try joining again.';
  };
}

export function openRoom(profile: Player, code: string | null, handlers: Handlers, restored?: HostedRoom) {
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
    joinFailure = trackConnectionSetup(connection, host, listeners.signal);
    timeLimit(failConnection);
    connection.on('iceStateChanged', state => {
      window.clearTimeout(connectionLost);
      if (!closed && playing && state === 'disconnected') {
        connectionLost = window.setTimeout(() => fail(lostOpponent), 5000);
      }
    });
    connection.on('open', () => {
      if (!host && !closed) transmit({ kind: 'hello', profile, acceptsColor: true });
    });
    connection.on('data', data => {
      if (closed || !data || typeof data !== 'object') return;
      if (playing) {
        lastMessage = performance.now();
        if ('kind' in data && data.kind === 'leave') {
          fail('Your opponent left the room.');
          return;
        }
        const action = roundAction(data);
        if (action) handlers.action(action);
        return;
      }
      const message = data as { kind?: unknown; profile?: unknown; acceptsColor?: unknown; guestColor?: unknown };
      if (message.kind !== (host ? 'hello' : 'welcome') || !isPlayer(message.profile)) return;
      const players: [Player, Player] = host ? [profile, message.profile] : [message.profile, profile];
      if (host) {
        // Earlier clients use their selected color locally and ignore welcome overrides.
        const color = message.acceptsColor === true
          ? assignGuestColor(profile.color, players[1].color) : players[1].color;
        players[1] = { ...players[1], color };
        if (!transmit({ kind: 'welcome', profile, guestColor: color })) return;
      } else if (typeof message.guestColor === 'string' && Object.hasOwn(palette, message.guestColor)) {
        players[1] = { ...profile, color: message.guestColor as Color };
      }
      playing = true;
      cancelTimeout();
      lastMessage = performance.now();
      heartbeat = window.setInterval(() => {
        if (performance.now() - lastMessage > 25_000) fail(lostOpponent);
        else transmit({ kind: 'ping' });
      }, 5_000);
      handlers.start(createMatch(players), host ? 0 : 1);
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
      ? new Peer(prefix + roomCode, { token: hostToken })
      : new Peer(prefix + 'guest-' + crypto.randomUUID());
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
        register(newCode());
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

  const roomCode = code ?? restored?.code ?? newCode();
  if (hostToken && navigator.locks) {
    const held = new Promise<void>(resolve => { releaseHostLock = resolve; });
    // A page can resume before the browser finishes releasing its previous lock.
    countdown = window.setTimeout(() => {
      fail(`Room ${roomCode} is open in another game window on this device. Return there to use your original invite.`, 'other-window');
    }, 1000);
    void navigator.locks.request(prefix + hostToken, { signal: listeners.signal }, () => {
      if (closed) return;
      register(roomCode);
      return held;
    }).catch(() => fail('This browser couldn’t open the room. Reopen the game and try again.'));
  } else {
    register(roomCode);
  }
  // A cached page can resume in the same match. Only an actual departure sends leave.
  window.addEventListener('pagehide', event => { if (!event.persisted) depart(); }, { signal: listeners.signal });
  return { close: () => close(true), send: (action: RoundAction) => transmit(action) };
}
