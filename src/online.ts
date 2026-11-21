import { Peer, type DataConnection } from 'peerjs';
import { createMatch, isPlayer, move, nextRound, type Match, type Player, type PlayerIndex } from './game';

const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const prefix = 'chrisawad-tic-tac-toe-v1-';
export const isRoomCode = (value: string) => /^[A-HJ-NP-Z2-9]{5}$/.test(value);

function newCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), value => letters[value % letters.length]).join('');
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

type Handlers = {
  waiting: (code: string) => void;
  start: (match: Match, index: PlayerIndex) => void;
  action: (action: RoundAction) => void;
  failure: (message: string) => void;
};

export function openRoom(profile: Player, code: string | null, handlers: Handlers) {
  const host = code === null;
  let peer: Peer;
  let channel: DataConnection | undefined;
  let countdown: number | undefined;
  let connectionLost: number | undefined;
  let heartbeat: number | undefined;
  let lastMessage = 0;
  let closed = false;
  let playing = false;
  let attempts = 0;

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
    window.removeEventListener('pagehide', depart);
    if (graceful && playing) window.setTimeout(() => peer.destroy(), 200);
    else peer.destroy();
  }
  function fail(message: string) {
    if (closed) return;
    close();
    handlers.failure(message);
  }
  function timeLimit(message: string) {
    cancelTimeout();
    countdown = window.setTimeout(() => fail(message), 16_000);
  }

  function useConnection(connection: DataConnection) {
    if (closed || channel) { connection.close(); return; }
    channel = connection;
    timeLimit('The devices couldn’t connect. Try again on a different network.');
    connection.on('iceStateChanged', state => {
      window.clearTimeout(connectionLost);
      if (!closed && playing && state === 'disconnected') {
        connectionLost = window.setTimeout(() => fail('Your opponent left the room.'), 5000);
      }
    });
    connection.on('open', () => {
      if (!host && !closed) transmit({ kind: 'hello', profile });
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
      const message = data as { kind?: unknown; profile?: unknown };
      if (message.kind !== (host ? 'hello' : 'welcome') || !isPlayer(message.profile)) return;
      if (host && !transmit({ kind: 'welcome', profile })) return;
      playing = true;
      cancelTimeout();
      lastMessage = performance.now();
      heartbeat = window.setInterval(() => {
        if (performance.now() - lastMessage > 25_000) fail('Your opponent left the room.');
        else transmit({ kind: 'ping' });
      }, 5_000);
      const players: [Player, Player] = host ? [profile, message.profile] : [message.profile, profile];
      handlers.start(createMatch(players), host ? 0 : 1);
    });
    connection.on('close', () => fail(playing ? 'Your opponent left the room.' : 'The room closed before the match could start.'));
    connection.on('error', () => fail('The connection was interrupted.'));
  }

  function transmit(data: object) {
    if (closed || !channel?.open) return false;
    try {
      channel.send(data);
      return true;
    } catch {
      fail('The connection was interrupted.');
      return false;
    }
  }

  function register(roomCode: string) {
    attempts++;
    peer = new Peer(host ? prefix + roomCode : prefix + 'guest-' + crypto.randomUUID());
    timeLimit('The room service is taking too long. Try again in a moment.');
    peer.on('open', () => {
      if (closed) return;
      cancelTimeout();
      if (host) handlers.waiting(roomCode);
      else useConnection(peer.connect(prefix + roomCode, { reliable: true, serialization: 'json' }));
    });
    if (host) peer.on('connection', useConnection);
    peer.on('error', error => {
      if (closed) return;
      if (host && error.type === 'unavailable-id' && attempts < 4) {
        peer.destroy();
        register(newCode());
      } else if (error.type === 'peer-unavailable') {
        fail('Room not found. Check the code and make sure the host is still waiting.');
      } else if (!playing || !channel?.open) {
        fail('Online rooms are currently unavailable. Check your connection and try again.');
      }
    });
    peer.on('disconnected', () => {
      if (!playing || !channel?.open) fail('Disconnected from the room service. Try again.');
    });
  }

  register(code ?? newCode());
  window.addEventListener('pagehide', depart);
  return { close: () => close(true), send: (action: RoundAction) => transmit(action) };
}
