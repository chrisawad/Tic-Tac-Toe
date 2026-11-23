import { boardFor, isPlayer, isRound, move, nextRound, palette, resultFor, type Color, type Match, type Player, type PlayerIndex, type Round } from './game';
import { createAuthoritativeMultiplayer, createRematchRule, createRoomCodes, createRoomFeedback, createRoomPersistence,
  type MatchView, type MultiplayerGame, type RematchRequest } from './multiplayer';

const codes = createRoomCodes(5);
const peerOptions = import.meta.env.VITE_PEER_HOST ? {
  host: import.meta.env.VITE_PEER_HOST, port: Number(import.meta.env.VITE_PEER_PORT || 443),
  secure: import.meta.env.VITE_PEER_SECURE !== 'false',
} : undefined;
export const feedback = createRoomFeedback(codes.length);
export const roomStore = createRoomPersistence<Player, '3x3'>({
  namespace: 'chrisawad-tic-tac-toe-v2', codes, isProfile: isPlayer,
  isSettings: (value): value is '3x3' => value === '3x3',
});

export const { enter, savedRoom } = createAuthoritativeMultiplayer<Player, '3x3', Round, number>({
  store: roomStore,
  peerOptions,
  relayUrl: import.meta.env.VITE_TURN_WORKER_URL,
  queueKey: size => size,
  settings: () => '3x3',
  initial: () => ({ round: 1, moves: [], playedScores: [0, 0, 0] }),
  advanceRound: nextRound,
  isState: isRound,
  isMove: (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 9,
  apply: (state, cell, seat) => move(state, cell, seat === 'Player1' ? 0 : 1) ?? state,
  revision: state => state.moves.length,
  finished: state => Boolean(resultFor(boardFor(state))),
  acceptGuest: (host, guest) => ({ name: guest.name, color: assignGuestColor(host.color, guest.color) }),
});
export type OnlineView = MatchView<Player, Round>;
export type Session = Awaited<ReturnType<typeof enter>>;

export function assignGuestColor(host: Color, guest: Color, random = Math.random): Color {
  if (guest !== host) return guest;
  const available = (Object.keys(palette) as Color[]).filter(color => color !== host);
  return available[Math.floor(random() * available.length)];
}

export type RoundAction =
  | { kind: 'move'; round: number; ply: number; cell: number }
  | RematchRequest;

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

export const readyForRematch = createRematchRule(nextRound);

export const ticTacToeOnline: MultiplayerGame<Player, RoundAction> = {
  namespace: 'chrisawad-tic-tac-toe-v1',
  storageKey: 'ttt:waiting-host',
  peerOptions,
  get relayUrl() { return import.meta.env.VITE_TURN_WORKER_URL; },
  isProfile: isPlayer,
  parseAction: roundAction,
  hello: { acceptsColor: true },
  acceptGuest(host, guest, hello) {
    // Earlier installed guests keep their original color and ignore welcome overrides.
    const color = hello.acceptsColor === true ? assignGuestColor(host.color, guest.color) : guest.color;
    return { profile: { ...guest, color }, welcome: { guestColor: color } };
  },
  acceptWelcome(guest, welcome) {
    const color = welcome.guestColor;
    return typeof color === 'string' && Object.hasOwn(palette, color) ? { ...guest, color: color as Color } : guest;
  },
};
