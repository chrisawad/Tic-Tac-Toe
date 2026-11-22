import { isPlayer, move, nextRound, palette, type Color, type Match, type Player, type PlayerIndex } from './game';
import { createRematchRule, type MultiplayerGame, type RematchRequest } from './multiplayer';

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
