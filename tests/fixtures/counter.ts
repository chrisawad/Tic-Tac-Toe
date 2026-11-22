import { createMultiplayer, type MultiplayerGame } from '../../src/multiplayer';

// This consumer has string profiles and counter actions. Its only game dependency is the public multiplayer API.
type Add = { kind: 'add'; points: number };
const counter: MultiplayerGame<string, Add> = {
  namespace: 'public-games-counter-test-v1',
  isProfile: (value): value is string => typeof value === 'string',
  parseAction(value) {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'add') return null;
    if (!('points' in value) || value.points !== 2) return null;
    return { kind: 'add', points: value.points };
  },
};

const code = document.querySelector<HTMLInputElement>('#code')!;
const status = document.querySelector<HTMLElement>('#status')!;
const total = document.querySelector<HTMLOutputElement>('#total')!;
function add(action: Add) { total.value = String(Number(total.value) + action.points); }

const game = createMultiplayer(counter, {
  invite(roomCode) { code.value = roomCode; },
  start(players, seat) { status.textContent = players.join(' + ') + ', seat ' + seat; },
  action: add,
  error(message) { status.textContent = message; },
});
document.querySelector('#host')!.addEventListener('click', () => game.host('Amy'));
document.querySelector('#join')!.addEventListener('click', () => game.join('Bea', code.value));
document.querySelector('#add')!.addEventListener('click', () => {
  const action: Add = { kind: 'add', points: 2 };
  if (game.send(action)) add(action);
});
document.querySelector('#leave')!.addEventListener('click', game.leave);
