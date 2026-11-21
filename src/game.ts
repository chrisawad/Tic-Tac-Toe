export const palette = {
  coral: '#ff7487',
  orange: '#ffad66',
  gold: '#ffd36e',
  mint: '#6ce8bc',
  blue: '#7eb7ff',
  violet: '#ad98ff',
  orchid: '#df9bff',
} as const;

export type Color = keyof typeof palette;
export type PlayerIndex = 0 | 1;
export type Mark = 'X' | 'O';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Mode = 'ai' | 'local' | 'online';
export type Player = { name: string; color: Color };
export type Result = { mark: Mark; line: readonly number[] } | { mark: null };
type Score = [number, number, number];
type Board = (Mark | null)[];

export interface Match {
  players: [Player, Player];
  round: number;
  moves: number[];
  playedScores: Score;
}

const lines = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export const difficulties = ['easy', 'medium', 'hard'] as const;
export const defaultPlayers: [Player, Player] = [
  { name: 'Player 1', color: 'violet' },
  { name: 'Player 2', color: 'mint' },
];

export function player(name: string, color: Color, fallback: string): Player {
  return { name: name.trim().slice(0, 20) || fallback, color };
}

export function isPlayer(value: unknown): value is Player {
  if (!value || typeof value !== 'object' || !('name' in value) || !('color' in value)) return false;
  const { name, color } = value;
  return typeof name === 'string' && name.trim() !== '' && name.length <= 20
    && typeof color === 'string' && Object.hasOwn(palette, color);
}

export function createMatch(players: [Player, Player]): Match {
  return { players, round: 1, moves: [], playedScores: [0, 0, 0] };
}

export function markFor(match: Match, index: PlayerIndex): Mark {
  return index === (match.round - 1) % 2 ? 'X' : 'O';
}

export function playerFor(match: Match, mark: Mark): PlayerIndex {
  return markFor(match, 0) === mark ? 0 : 1;
}

export function turn(match: Match): Mark {
  return match.moves.length % 2 === 0 ? 'X' : 'O';
}

export function boardFor(match: Match): Board {
  const board: Board = Array(9).fill(null);
  match.moves.forEach((cell, i) => { board[cell] = i % 2 === 0 ? 'X' : 'O'; });
  return board;
}

export function resultFor(board: readonly (Mark | null)[]): Result | null {
  for (const line of lines) {
    const [a, b, c] = line;
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return { mark, line };
  }
  return board.every(Boolean) ? { mark: null } : null;
}

export function move(match: Match, index: number, actor: PlayerIndex): Match | null {
  if (!Number.isInteger(index) || index < 0 || index > 8 || match.moves.includes(index)
    || actor !== playerFor(match, turn(match)) || resultFor(boardFor(match))) return null;
  return { ...match, moves: [...match.moves, index] };
}

export function scoresFor(match: Match): Score {
  const scores: Score = [...match.playedScores];
  const result = resultFor(boardFor(match));
  if (result) scores[result.mark ? playerFor(match, result.mark) : 2]++;
  return scores;
}

export function nextRound(match: Match): Match {
  if (!resultFor(boardFor(match))) return match;
  return { ...match, round: match.round + 1, moves: [], playedScores: scoresFor(match) };
}

export function restoreMatch(value: unknown): Match | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Match;
  if (!Array.isArray(saved.players) || saved.players.length !== 2 || !saved.players.every(isPlayer)
    || !Number.isSafeInteger(saved.round) || saved.round < 1
    || !Array.isArray(saved.moves) || saved.moves.length > 9
    || !Array.isArray(saved.playedScores) || saved.playedScores.length !== 3
    || !saved.playedScores.every(score => Number.isSafeInteger(score) && score >= 0)
    || saved.playedScores.reduce((sum, score) => sum + score, 0) !== saved.round - 1) return null;

  let match = { ...createMatch(saved.players), round: saved.round, playedScores: saved.playedScores };
  for (const cell of saved.moves) {
    const next = move(match, cell, playerFor(match, turn(match)));
    if (!next) return null;
    match = next;
  }
  return match;
}

function freeCells(board: Board) {
  return board.flatMap((mark, index) => mark ? [] : [index]);
}

function other(mark: Mark): Mark {
  return mark === 'X' ? 'O' : 'X';
}

function rate(board: Board, active: Mark, ai: Mark, depth: number): number {
  const result = resultFor(board);
  if (result) return result.mark === ai ? 10 - depth : result.mark ? depth - 10 : 0;
  const scores = freeCells(board).map(cell => {
    board[cell] = active;
    const score = rate(board, other(active), ai, depth + 1);
    board[cell] = null;
    return score;
  });
  return active === ai ? Math.max(...scores) : Math.min(...scores);
}

function winningCell(board: Board, cells: number[], mark: Mark) {
  return cells.find(cell => {
    board[cell] = mark;
    const wins = resultFor(board)?.mark === mark;
    board[cell] = null;
    return wins;
  });
}

export function aiMove(match: Match, difficulty: Difficulty, random = Math.random): number | undefined {
  const board = boardFor(match);
  if (resultFor(board)) return;
  const cells = freeCells(board);
  const ai = turn(match);
  const choose = (options: number[]) => options[Math.floor(random() * options.length)];
  if (difficulty === 'easy') return choose(cells);
  const immediate = winningCell(board, cells, ai);
  if (immediate !== undefined) return immediate;
  if (difficulty === 'medium') return winningCell(board, cells, other(ai)) ?? choose(cells);
  let best = -Infinity;
  let choices: number[] = [];
  for (const cell of cells) {
    board[cell] = ai;
    const score = rate(board, other(ai), ai, 1);
    board[cell] = null;
    if (score > best) { best = score; choices = []; }
    if (score === best) choices.push(cell);
  }
  return choose(choices);
}
