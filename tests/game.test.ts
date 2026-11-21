import { describe, expect, it } from 'vitest';
import { aiMove, boardFor, createMatch, defaultPlayers, markFor, move, nextRound, playerFor, restoreMatch, resultFor, scoresFor, turn, type Match } from '../src/game';
import { applyRoomMove, assignGuestColor, readyForRematch, roundAction } from '../src/online';

function play(cells: number[], match = createMatch(defaultPlayers)): Match {
  return cells.reduce((state, cell) => move(state, cell, playerFor(state, turn(state)))!, match);
}

describe('match rules', () => {
  it.each([
    [[0, 1, 2], [0, 4, 1, 3, 2]],
    [[0, 3, 6], [0, 1, 3, 4, 6]],
    [[0, 4, 8], [0, 1, 4, 2, 8]],
    [[2, 4, 6], [2, 1, 4, 8, 6]],
  ])('marks a complete line %j', (line, plays) => {
    const match = play(plays);
    expect(resultFor(boardFor(match))).toEqual({ mark: 'X', line });
    expect(move(match, 7, 1)).toBeNull();
  });

  it('scores a full-board draw once and alternates the opening player', () => {
    const drawn = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(resultFor(boardFor(drawn))).toEqual({ mark: null });
    expect(scoresFor(drawn)).toEqual([0, 0, 1]);
    const second = nextRound(drawn);
    expect(markFor(second, 1)).toBe('X');
    expect(scoresFor(second)).toEqual([0, 0, 1]);
    expect(move(second, 0, 0)).toBeNull();
    expect(nextRound(second)).toBe(second);
  });

  it('restores completed and in-progress games and rejects invalid saves', () => {
    const final = play([0, 3, 1, 4, 2]);
    expect(restoreMatch(final)).toEqual(final);
    const partial = play([0, 4, 2], nextRound(final));
    expect(restoreMatch(partial)).toEqual(partial);
    expect(restoreMatch({ ...partial, moves: [0, 0] })).toBeNull();
    expect(restoreMatch({ ...final, moves: [...final.moves, 7] })).toBeNull();
    expect(restoreMatch({ ...partial, playedScores: [0, 0, 0] })).toBeNull();
  });
});

describe('computer opponent', () => {
  it('takes wins before blocking and blocks an immediate threat on Medium', () => {
    expect(aiMove(play([0, 3, 1, 4, 8]), 'medium')).toBe(5);
    expect(aiMove(play([0, 3, 1]), 'medium')).toBe(2);
    expect(aiMove(play([0, 3, 1]), 'easy', () => .5)).toBe(6);
  });

  it('never loses on Hard against any response when playing either mark', () => {
    function check(state: Match, ai: 'X' | 'O') {
      const board = boardFor(state);
      const result = resultFor(board);
      if (result) {
        expect(result.mark === null || result.mark === ai).toBe(true);
        return;
      }
      if (turn(state) === ai) {
        check(play([aiMove(state, 'hard', () => 0)!], state), ai);
        return;
      }
      board.forEach((mark, i) => { if (!mark) check(play([i], state), ai); });
    }
    for (const mark of ['X', 'O'] as const) check(createMatch(defaultPlayers), mark);
  });
});

describe('room protocol', () => {
  it('preserves distinct selections and can draw every other color on a conflict', () => {
    expect(assignGuestColor('mint', 'blue')).toBe('blue');
    const alternatives = Array.from({ length: 6 }, (_, index) =>
      assignGuestColor('mint', 'mint', () => (index + .5) / 6));
    expect(new Set(alternatives).size).toBe(6);
    expect(alternatives).not.toContain('mint');
  });
  it('rejects malformed, stale, duplicate, and out-of-turn moves', () => {
    const first = createMatch(defaultPlayers);
    const action = { kind: 'move', round: 1, ply: 0, cell: 4 } as const;
    expect(roundAction({ ...action, cell: '4' })).toBeNull();
    expect(applyRoomMove(first, 1, action)).toBeNull();
    expect(applyRoomMove(first, 0, { ...action, round: 2 })).toBeNull();
    const placed = applyRoomMove(first, 0, action)!;
    expect(placed.moves).toEqual([4]);
    expect(applyRoomMove(placed, 1, action)).toBeNull();
  });

  it('requires both players to accept the same finished round', () => {
    const final = play([0, 3, 1, 4, 2]);
    const ready: [boolean, boolean] = [false, false];
    expect(readyForRematch(final, ready, 0, 1)).toBe(final);
    expect(readyForRematch(final, ready, 0, 1)).toBe(final);
    expect(readyForRematch(final, ready, 1, 2)).toBe(final);
    expect(readyForRematch(final, ready, 1, 1)).toEqual(nextRound(final));
  });
});
