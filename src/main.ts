import '@fontsource-variable/outfit/wght.css';
import '@fontsource-variable/bricolage-grotesque/wght.css';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Bot, CircleHelp, Download, Equal, Grid3x3, Link2, Radio, RefreshCw,
  RotateCcw, Share2, Trophy, UsersRound, Volume2, VolumeX, createIcons,
} from 'lucide';
import { gameAudio, winConfetti } from './celebration';
import {
  aiMove, boardFor, createMatch, defaultPlayers, difficulties, isPlayer, markFor, move, nextRound,
  palette, player, playerFor, restoreMatch, resultFor, scoresFor, turn,
  type Color, type Difficulty, type Match, type Mode, type Player, type PlayerIndex,
} from './game';
import { setupInstall } from './install';
import { createMultiplayer, createInviteControls, inviteURL, inviteValue, isRoomCode, NoHostReply, readInviteCode, setInviteCode } from './multiplayer';
import { applyRoomMove, enter, feedback, readyForRematch, roomStore, savedRoom, ticTacToeOnline,
  type OnlineView, type RoundAction, type Session } from './online';
import './style.css';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem('ttt:' + key) ?? 'null'); }
  catch { return null; }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem('ttt:' + key, JSON.stringify(value)); }
  catch { /* The current game can continue without persistent storage. */ }
}

const modeInfo = {
  ai: ['AI Battle', 'Choose your color and how tough T-3PO should play.'],
  local: ['Local PvP', 'Set up two players and take turns on this screen.'],
  online: ['Play Online', 'Create a room or join a friend’s game.'],
} as const;
const difficultyHints = {
  easy: 'T-3PO plays at random.',
  medium: 'T-3PO spots immediate wins and blocks.',
  hard: 'T-3PO looks ahead and plays a perfect game.',
};

const form = element<HTMLFormElement>('setup-form');
const joinCode = element<HTMLInputElement>('join-code');
const joinError = element('join-error');
const shareGameDialog = element<HTMLDialogElement>('share-game-dialog');
const gameLink = element<HTMLInputElement>('share-game-link');
const resultDialog = element<HTMLDialogElement>('result-dialog');
const connectionRoute = element('connection-route');
const leaveDialog = element<HTMLDialogElement>('leave-dialog');
const boardElement = element('board');
const strike = element('strike');
const cells: HTMLButtonElement[] = [];
const colors = Object.entries(palette) as [Color, string][];
const audio = gameAudio();
const celebration = winConfetti(element<HTMLCanvasElement>('confetti'));
let audioEnabled = read('sound') !== false;
let screen = 'home';
let mode: Mode = 'local';
let difficulty: Difficulty = 'medium';
let match: Match | null = null;
let aiTimer: number | undefined;
let resultTimer: number | undefined;
let noticeTimer: number | undefined;
let roomPlayer: PlayerIndex = 0;
let ready: [boolean, boolean] = [false, false];
let session: Session | undefined;
let opening: AbortController | undefined;
let onlineView: OnlineView | undefined;
type RoomRole = 'host' | 'guest' | 'public';
type Operation = Parameters<typeof enter>[0];
const invitations = createInviteControls({
  code: element('room-code'), link: element('invite-link'), qr: element('room-qr'),
  copy: element('copy-room'), share: element('share-room'),
}, { title: 'Play Tic Tac Toe', text: 'Join my Tic Tac Toe room.' }, () => notify('Invite link copied.'),
  code => inviteURL(code, gameLink.value, 'fragment'));

function notify(message: string) {
  element('notice').textContent = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { element('notice').textContent = ''; }, 4000);
}

function updateSound() {
  audio.enable(audioEnabled);
  element('sound-button').setAttribute('aria-pressed', String(audioEnabled));
  element('sound-on').hidden = !audioEnabled;
  element('sound-off').hidden = audioEnabled;
}

function showScreen(name: 'home' | 'setup' | 'room' | 'game') {
  if (screen === name) return;
  element(screen).hidden = true;
  screen = name;
  element(screen).hidden = false;
  element(screen + '-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function savedMode(which: 'ai' | 'local') {
  const saved = read('match:' + which);
  if (!saved || typeof saved !== 'object' || !('match' in saved) || !('difficulty' in saved)) return null;
  const restored = restoreMatch(saved.match);
  const level = saved.difficulty as Difficulty;
  return restored && difficulties.includes(level) ? { match: restored, difficulty: level } : null;
}

function writeMatch() {
  if (mode !== 'online') save('match:' + mode, { match, difficulty });
}

function markMarkup(mark: string) {
  return `<i class="mark ${mark.toLowerCase()}" aria-hidden="true"></i>`;
}

function profileFields(slot: 'one' | 'two', label: string, mark: 'X' | 'O', profile: Player) {
  const container = element('profile-' + slot);
  container.innerHTML = `
    <div class="profile-heading">
      <span class="profile-icon" style="color:${palette[profile.color]}">${markMarkup(mark)}</span>
      <span><strong>${label}</strong><small>${mode === 'online' ? 'Choose your look' : 'Starts as ' + mark}</small></span>
    </div>
    <label for="name-${slot}">Name</label>
    <input class="name-input" id="name-${slot}" name="name-${slot}" maxlength="20" autocomplete="off">
    <fieldset><legend>Choose color</legend><div class="swatches">${colors.map(([color, hex]) => `
      <label class="swatch" style="--swatch:${hex}">
        <input type="radio" name="color-${slot}" value="${color}" aria-label="${color}" ${profile.color === color ? 'checked' : ''}>
        <span aria-hidden="true"></span>
      </label>`).join('')}</div></fieldset>`;
  element<HTMLInputElement>('name-' + slot).value = profile.name;
  container.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'color-' + slot) {
      container.querySelector<HTMLElement>('.profile-icon')!.style.color = palette[input.value as Color];
    }
  }, { signal: setupEvents.signal });
}

let setupEvents = new AbortController();
function clearRoomError() {
  joinError.textContent = '';
  joinCode.removeAttribute('aria-invalid');
  joinCode.removeAttribute('aria-describedby');
}

function showRoomError(message: string) {
  joinError.textContent = message;
  joinError.focus();
}

function setRoomRole(role: RoomRole) {
  const joining = role === 'guest';
  form.querySelector<HTMLInputElement>(`[name="room-role"][value="${role}"]`)!.checked = true;
  element('code-field').hidden = !joining;
  joinCode.disabled = !joining;
  clearRoomError();
  element('room-hint').textContent = joining
    ? 'Use the five-character code from your friend.'
    : role === 'public' ? 'Play the next available opponent on a 3×3 board.'
    : 'Invite a friend with a code, link, or QR code.';
  element('start-label').textContent = { guest: 'Join room', public: 'Find public game', host: 'Create private room' }[role];
  const icon = element('profile-one').querySelector<HTMLElement>('.profile-icon')!;
  icon.innerHTML = markMarkup(joining ? 'O' : 'X');
  element('profile-one').querySelector('small')!.textContent = role === 'public' ? 'Choose your look' : joining ? 'Starts as O' : 'Starts as X';
}

function openSetup(next: Mode, code = '') {
  mode = next;
  setupEvents.abort();
  setupEvents = new AbortController();
  const stored = read('profiles:' + mode);
  const data = Array.isArray(stored) ? stored : [];
  const first = isPlayer(data[0]) ? data[0] : { ...defaultPlayers[0], color: code ? 'mint' : 'violet' } as const;
  profileFields('one', mode === 'local' ? 'Player 1' : 'Your player', 'X', first);
  profileFields('two', 'Player 2', 'O', isPlayer(data[1]) ? data[1] : defaultPlayers[1]);
  const savedDifficulty = read('difficulty') as Difficulty;
  setDifficulty(difficulties.includes(savedDifficulty) ? savedDifficulty : 'medium');
  element('setup-title').textContent = modeInfo[mode][0];
  element('setup-description').textContent = modeInfo[mode][1];
  element('profile-two').hidden = mode !== 'local';
  element('ai-options').hidden = mode !== 'ai';
  element('room-choice').hidden = mode !== 'online';
  form.classList.toggle('online-form', mode === 'online');
  element('setup-description').hidden = mode === 'online';
  if (mode === 'online') setRoomRole(code ? 'guest' : 'host');
  else element('start-label').textContent = 'Start battle';
  element('resume-button').hidden = mode === 'online' ? !savedRoom() : !savedMode(mode);
  element('resume-button').textContent = mode === 'online' ? 'Resume room' : 'Resume match';
  joinCode.value = code;
  clearRoomError();
  showScreen('setup');
}

function setDifficulty(value: Difficulty) {
  difficulty = value;
  form.querySelector<HTMLInputElement>(`[name="difficulty"][value="${difficulty}"]`)!.checked = true;
  element('difficulty-hint').textContent = difficultyHints[difficulty];
}

function profileFrom(formData: FormData, slot: 'one' | 'two', fallback: Player) {
  return player(String(formData.get('name-' + slot) ?? ''), (formData.get('color-' + slot) as Color) || fallback.color, fallback.name);
}

function clearGame() {
  opening?.abort();
  opening = undefined;
  const current = session;
  session = undefined;
  void current?.leave();
  multiplayer.leave();
  invitations.clear();
  window.clearTimeout(aiTimer);
  window.clearTimeout(resultTimer);
  celebration.stop();
  if (resultDialog.open) resultDialog.close();
  match = null;
  onlineView = undefined;
}

function goHome() {
  clearGame();
  clearInviteURL();
  showScreen('home');
}

function requestHome() {
  if (mode === 'online' && screen === 'game') leaveDialog.showModal();
  else goHome();
}

function startGame(newMatch: Match) {
  const back = mode === 'online' ? 'Leave room' : 'All modes';
  element('game-back-label').textContent = back;
  element('result-menu').textContent = back;
  connectionRoute.hidden = mode !== 'online';
  connectionRoute.textContent = '';
  match = newMatch;
  ready = [false, false];
  element('game-mode').textContent = mode === 'ai' ? `AI Battle · ${difficulty}` : modeInfo[mode][0];
  showScreen('game');
  renderGame();
  scheduleAI();
}

function updateStrike() {
  if (!match || strike.hidden) return;
  const result = resultFor(boardFor(match));
  if (!result?.mark) return;
  const [first, , last] = result.line;
  const board = boardElement.getBoundingClientRect();
  const start = cells[first].getBoundingClientRect();
  const end = cells[last].getBoundingClientRect();
  if (!start.width) return;
  const x = start.left + start.width / 2 - board.left;
  const y = start.top + start.height / 2 - board.top;
  const dx = end.left + end.width / 2 - board.left - x;
  const dy = end.top + end.height / 2 - board.top - y;
  // Leave the same inset at the edge of a winning cell in every direction.
  const extension = start.width * .4 / Math.max(Math.abs(dx), Math.abs(dy));
  strike.style.setProperty('--left', `${x - dx * extension}px`);
  strike.style.setProperty('--top', `${y - dy * extension}px`);
  strike.style.setProperty('--length', `${Math.hypot(dx, dy) * (1 + 2 * extension)}px`);
  strike.style.setProperty('--angle', `${Math.atan2(dy, dx)}rad`);
}

function showTurnStatus(message: string, playerName?: string) {
  const status = element('turn-status');
  if (playerName) {
    const name = document.createElement('span');
    name.textContent = playerName;
    status.replaceChildren(name, message);
  } else status.textContent = message;
}

function renderGame() {
  if (!match) return;
  const current = match;
  const board = boardFor(current);
  const result = resultFor(board);
  const active = playerFor(current, turn(current));
  const winner = result?.mark ? playerFor(current, result.mark) : null;
  const isMyTurn = (mode === 'local' || active === (mode === 'ai' ? 0 : roomPlayer))
    && (!onlineView || (onlineView.connected && !onlineView.syncing));
  const roundCounter = element('round-counter');
  roundCounter.textContent = `Round ${current.round}`;
  roundCounter.hidden = Boolean(result);
  element('result-button').hidden = !result;
  if (onlineView && (!onlineView.connected || onlineView.notice)) showTurnStatus(onlineView.notice || 'Board saved. Waiting for your opponent to reconnect…');
  else if (onlineView?.syncing) showTurnStatus('Sending your move…');
  else if (winner !== null) showTurnStatus(' wins the round!', current.players[winner].name);
  else if (result) showTurnStatus('The round is a draw.');
  else if (mode === 'online' && isMyTurn) showTurnStatus(`Your turn · ${turn(current)}`);
  else if (mode === 'ai' && active === 1) showTurnStatus('T-3PO is thinking…');
  else showTurnStatus(`’s turn · ${turn(current)}`, current.players[active].name);
  const players = element('players');
  players.replaceChildren(...current.players.map((profile, index) => {
    const card = document.createElement('div');
    card.className = 'player-card' + (!result && index === active ? ' active' : '');
    card.style.setProperty('--player', palette[profile.color]);
    card.innerHTML = `${markMarkup(markFor(current, index as PlayerIndex))}<span class="player-label"><strong></strong><small></small></span>`;
    card.querySelector('strong')!.textContent = profile.name;
    card.querySelector('small')!.textContent = mode === 'online' && index === roomPlayer ? 'You'
      : mode === 'ai' && index === 1 ? 'Computer'
        : !result && index === active ? 'Up next' : `Plays ${markFor(current, index as PlayerIndex)}`;
    return card;
  }));
  const [first, second, draws] = scoresFor(current);
  const entries: [string, number, Color?][] = [
    [current.players[0].name, first, current.players[0].color], ['Draws', draws], [current.players[1].name, second, current.players[1].color],
  ];
  element('score').replaceChildren(...entries.map(([name, score, color]) => {
    const entry = document.createElement('div');
    const term = document.createElement('dt');
    const count = document.createElement('dd');
    term.textContent = name;
    count.textContent = String(score);
    if (color) entry.style.setProperty('--player', palette[color]);
    entry.append(term, count);
    return entry;
  }));
  board.forEach((mark, i) => {
    const cell = cells[i];
    const occupied = mark !== null;
    if (cell.dataset.mark !== (mark ?? '')) {
      cell.innerHTML = mark ? markMarkup(mark) : '';
      cell.dataset.mark = mark ?? '';
    }
    const color = mark ? current.players[playerFor(current, mark)].color : current.players[active].color;
    cell.style.setProperty('--player', palette[color]);
    cell.classList.toggle('last', current.moves.at(-1) === i);
    cell.classList.toggle('winning', Boolean(result?.mark && result.line.includes(i)));
    cell.setAttribute('aria-label', `Square ${i + 1}, ${mark ?? 'empty'}`);
    cell.setAttribute('aria-disabled', String(occupied || Boolean(result) || !isMyTurn));
  });
  strike.hidden = !result?.mark;
  updateStrike();
}

function showResult(animate: boolean) {
  if (!match || leaveDialog.open || screen !== 'game') return;
  const result = resultFor(boardFor(match));
  if (!result) return;
  const winner = result.mark ? match.players[playerFor(match, result.mark)] : null;
  const next = match.players[(match.round % 2) as PlayerIndex];
  const waiting = mode === 'online' && ready[roomPlayer];
  element('result-trophy').hidden = !winner;
  element('result-draw').hidden = Boolean(winner);
  element('result-title').textContent = winner ? `${winner.name} wins!` : 'It’s a draw!';
  resultDialog.style.setProperty('--winner', winner ? palette[winner.color] : '#e5d8ff');
  element('result-detail').textContent = waiting ? 'Waiting for your opponent to accept.' : `${next.name} gets X and goes first in the rematch.`;
  element<HTMLButtonElement>('rematch-button').disabled = waiting || Boolean(onlineView && !onlineView.connected);
  element('rematch-label').textContent = waiting ? 'Ready' : 'Rematch';
  if (!resultDialog.open) resultDialog.showModal();
  if (animate && winner) {
    celebration.play(palette[winner.color]);
    audio.win();
  }
}

function finishMove(next: Match) {
  if (!match) return;
  audio.place(turn(match));
  match = next;
  writeMatch();
  renderGame();
  if (resultFor(boardFor(match))) resultTimer = window.setTimeout(() => showResult(true), 440);
  else scheduleAI();
}

function scheduleAI() {
  window.clearTimeout(aiTimer);
  if (mode !== 'ai' || !match || resultFor(boardFor(match)) || playerFor(match, turn(match)) !== 1) return;
  aiTimer = window.setTimeout(() => {
    if (!match || screen !== 'game') return;
    const cell = aiMove(match, difficulty);
    const next = cell === undefined ? null : move(match, cell, 1);
    if (next) finishMove(next);
  }, 375);
}

function placeMark(index: number) {
  audio.unlock();
  if (!match) return;
  if (session) { session.move(index); return; }
  const actor = mode === 'online' ? roomPlayer : mode === 'ai' ? 0 : playerFor(match, turn(match));
  const next = move(match, index, actor);
  if (!next) return;
  if (mode === 'online' && !multiplayer.send({ kind: 'move', round: match.round, ply: match.moves.length, cell: index })) return;
  finishMove(next);
}

function rematch(next: Match) {
  if (resultDialog.open) resultDialog.close();
  window.clearTimeout(resultTimer);
  celebration.stop();
  match = next;
  ready = [false, false];
  writeMatch();
  renderGame();
  cells[0].focus({ preventScroll: true });
  scheduleAI();
}

function receive(action: RoundAction, actor: PlayerIndex) {
  if (!match) return;
  if (action.kind === 'move') {
    const next = applyRoomMove(match, actor, action);
    if (next) finishMove(next);
  } else {
    const next = readyForRematch(match, ready, actor, action.round);
    if (next !== match) rematch(next);
  }
}

const multiplayer = createMultiplayer(ticTacToeOnline, {
  opening(code, restoring) {
    if (mode !== 'online') openSetup('online', code ?? '');
    if (!restoring) {
      invitations.clear();
      element('invite').hidden = true;
      element('room-status').textContent = code ? `Joining room ${code}…` : 'Creating your room…';
    }
    showScreen('room');
  },
  invite(code, message) {
    element('room-status').textContent = message;
    element('invite').hidden = false;
    void invitations.show(code);
  },
  status(message) { element('room-status').textContent = message; },
  route(route) { connectionRoute.textContent = { direct: 'Direct', relay: 'Via relay', unknown: 'Route unknown' }[route]; },
  start(players, seat, selected) {
    invitations.clear();
    roomPlayer = seat;
    startGame(createMatch(players));
    if (seat === 1 && players[1].color !== selected.color) {
      notify(`You’re playing ${players[1].color}. Your host picked ${selected.color} too.`);
    }
  },
  action: receive,
  error(message, code) {
    if (leaveDialog.open) leaveDialog.close('stay');
    goHome();
    openSetup('online', code ?? '');
    showRoomError(message);
  },
});

function clearInviteURL() {
  const url = new URL(location.href);
  if (inviteValue(url) === null) return;
  setInviteCode(url, null);
  history.replaceState(null, '', url);
}

function exitOnline() {
  clearGame();
  clearInviteURL();
  openSetup('online');
}

function showOnline(view: OnlineView, selected: Player) {
  const { room, seat } = view;
  const previous = onlineView;
  onlineView = view;
  if (!previous) {
    const url = new URL(location.href);
    if (inviteValue(url) !== null && readInviteCode(url) !== room.code) {
      setInviteCode(url, room.code);
      history.replaceState(null, '', url);
    }
  }
  if (room.status === 'abandoned') {
    exitOnline();
    if (leaveDialog.open) leaveDialog.close('stay');
    showRoomError(view.notice || 'Your opponent left the room. Create a room or find a public game to play again.');
    return;
  }
  if (room.status === 'waiting' || !room.players.player2) {
    element('room-status').textContent = view.notice || (room.public ? 'Looking for another player…' : 'Waiting for a friend to join…');
    element('invite').hidden = false;
    if (element('room-code').textContent !== room.code) void invitations.show(room.code);
    return;
  }
  roomPlayer = seat === 'Player1' ? 0 : 1;
  const next: Match = { ...room.state, players: [room.players.player1, room.players.player2] };
  if (!match || screen !== 'game') {
    invitations.clear();
    startGame(next);
    if (view.connected && roomPlayer === 1 && next.players[1].color !== selected.color)
      notify(`You’re playing ${next.players[1].color}. Your host picked ${selected.color} too.`);
  } else if (match.round !== next.round) rematch(next);
  else if (next.moves.length > match.moves.length) finishMove(next);
  else { match = next; renderGame(); }
  ready = room.rematchVotes ?? [false, false];
  connectionRoute.textContent = view.connected
    ? { direct: 'Direct', relay: 'Via relay', unknown: 'Route unknown' }[view.route] : 'Reconnecting…';
  if (room.status === 'finished' && resultDialog.open) showResult(false);
}

async function openOnline(action: Operation, profile: Player, code = '') {
  opening?.abort();
  const attempt = new AbortController();
  opening = attempt;
  const status = element('room-status');
  invitations.clear();
  element('invite').hidden = true;
  status.textContent = { create: 'Creating your room…', join: `Joining room ${code}…`,
    public: 'Looking for another player…', restore: 'Reopening your room…' }[action];
  showScreen('room');
  try {
    const room = await enter(action, profile, '3x3', code, message => {
      if (!attempt.signal.aborted) status.textContent = message;
    }, attempt.signal);
    if (attempt.signal.aborted) { room.stop(); return; }
    session = room;
    room.watch(view => { if (session === room) showOnline(view, profile); });
  } catch (error) {
    if (attempt.signal.aborted) return;
    if (action === 'join' && (error instanceof NoHostReply || (error as { type?: string })?.type === 'peer-unavailable')) {
      // Invites issued before recoverable matches use the same five characters on the original endpoint.
      // The primary lookup already allowed time for a suspended host to return.
      multiplayer.join(profile, code, 0);
      return;
    }
    showScreen('setup');
    showRoomError(feedback.roomFailure(error, action));
  } finally {
    if (opening === attempt) opening = undefined;
  }
}

for (let i = 0; i < 9; i++) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell';
  cell.addEventListener('click', () => placeMark(i));
  cell.addEventListener('keydown', event => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
    const offset = steps[event.key];
    if (!offset) return;
    event.preventDefault();
    cells[(i + offset + 9) % 9].focus();
  });
  cells.push(cell);
  boardElement.append(cell);
}
new ResizeObserver(updateStrike).observe(boardElement);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => openSetup(button.dataset.mode as Mode));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-home], #home-button')) {
  button.addEventListener('click', requestHome);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog]')) {
  button.addEventListener('click', () => element<HTMLDialogElement>(button.dataset.dialog + '-dialog').showModal());
}
async function shareGame() {
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url: gameLink.value });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  element('share-game-status').textContent = '';
  shareGameDialog.showModal();
  gameLink.select();
}
for (const button of document.querySelectorAll('[data-share-game]')) {
  button.addEventListener('click', shareGame);
}
function enableGameLinkCopy(link: HTMLInputElement, button: HTMLElement, status: HTMLElement) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = 'Game link copied.';
    } catch {
      link.focus();
      link.select();
      status.textContent = 'Copy the selected link.';
    }
  }
  if ('commandForElement' in HTMLButtonElement.prototype) link.addEventListener('command', copy);
  else button.addEventListener('click', copy);
}
enableGameLinkCopy(gameLink, element('copy-game-link'), element('share-game-status'));
const installLink = element<HTMLInputElement>('install-game-link');
installLink.value = gameLink.value;
enableGameLinkCopy(installLink, element('copy-install-link'), element('install-copy-status'));

element('room-back').addEventListener('click', exitOnline);
element('sound-button').addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  updateSound();
  if (audioEnabled) { audio.unlock(); audio.place('X'); }
  save('sound', audioEnabled);
});
element('resume-button').addEventListener('click', () => {
  if (mode === 'online') {
    const saved = savedRoom();
    if (saved) void openOnline('restore', saved.room.players.player1, saved.room.code);
    return;
  }
  const saved = savedMode(mode);
  if (!saved) return;
  audio.unlock();
  difficulty = saved.difficulty;
  startGame(saved.match);
});
form.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.name === 'difficulty') setDifficulty(input.value as Difficulty);
  if (input.name === 'room-role') setRoomRole(input.value as RoomRole);
});
joinCode.addEventListener('input', clearRoomError);
form.addEventListener('submit', event => {
  event.preventDefault();
  const input = new FormData(form);
  const first = profileFrom(input, 'one', defaultPlayers[0]);
  const second = profileFrom(input, 'two', defaultPlayers[1]);
  save('profiles:' + mode, [first, second]);
  audio.unlock();
  if (mode === 'online') {
    const role = input.get('room-role');
    if (role !== 'guest') {
      void openOnline(role === 'public' ? 'public' : 'create', first);
      return;
    }
    const code = joinCode.value.trim().toUpperCase();
    if (!isRoomCode(code)) {
      joinError.textContent = 'Enter the five-character code from your friend.';
      joinCode.setAttribute('aria-invalid', 'true');
      joinCode.setAttribute('aria-describedby', joinError.id);
      joinCode.focus();
      return;
    }
    void openOnline('join', first, code);
    return;
  }
  if (mode === 'ai') save('difficulty', difficulty);
  startGame(createMatch([first, mode === 'ai' ? { name: 'T-3PO', color: 'coral' } : second]));
  writeMatch();
});
leaveDialog.addEventListener('close', () => {
  const action = leaveDialog.returnValue;
  leaveDialog.returnValue = '';
  if (action === 'leave') exitOnline();
});
resultDialog.addEventListener('close', () => {
  celebration.stop();
  const action = resultDialog.returnValue;
  resultDialog.returnValue = '';
  if (!match) return;
  if (action === 'menu') requestHome();
  if (action === 'rematch' && mode !== 'online') rematch(nextRound(match));
  if (action === 'rematch' && mode === 'online') {
    if (session) {
      session.rematch();
      if (match && resultFor(boardFor(match))) showResult(false);
      return;
    }
    const message = { kind: 'ready' as const, round: match.round };
    if (ready[roomPlayer] || !multiplayer.send(message)) return;
    const current = match;
    receive(message, roomPlayer);
    if (current === match) showResult(false);
  }
});
element('result-button').addEventListener('click', () => showResult(false));

createIcons({
  icons: { ArrowLeft, ArrowRight, ArrowUpRight, Bot, CircleHelp, Download, Equal, Grid3x3, Link2, Radio, RefreshCw, RotateCcw, Share2, Trophy, UsersRound, Volume2, VolumeX },
  attrs: { 'aria-hidden': 'true' },
});
updateSound();
window.addEventListener('hashchange', event => {
  const requested = inviteValue(new URL(event.newURL));
  if (requested !== null && requested !== inviteValue(new URL(event.oldURL))) location.reload();
});
const url = new URL(location.href);
const invited = readInviteCode(url);
const hasInvite = inviteValue(url) !== null;
const saved = !hasInvite || invited ? savedRoom(invited ?? undefined) : undefined;
const waiting = roomStore.waitingHost.read();
const restoreCode = saved?.room.code ?? (waiting && (!hasInvite || waiting.code === invited) ? waiting.code : '');
if (hasInvite || restoreCode) openSetup('online', invited || inviteValue(url) || '');
if (restoreCode) void openOnline('restore', saved?.room.players.player1 ?? waiting!.profile.player, restoreCode);
else if (hasInvite && !invited) {
  setRoomRole('guest');
  showRoomError(feedback.roomMessages.invalidCode);
}
const restoredHost = !restoreCode && (!hasInvite || !!invited) && multiplayer.restore(invited ?? undefined);
setupInstall(
  element('install-button'), element('install-help-button'), element('install-dialog'), element('update-button'),
  notify, {
    offerOnLaunch: !hasInvite && !restoreCode && !restoredHost,
    beforeUpdateReload: () => {
      const code = joinCode.value.trim().toUpperCase();
      if (mode !== 'online' || (screen !== 'setup' && screen !== 'room') || joinCode.disabled || !isRoomCode(code)) return;
      const target = new URL(location.href);
      setInviteCode(target, code);
      history.replaceState(null, '', target);
    },
  },
);
