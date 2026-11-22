import type { Seat } from './room';

export type RematchRequest = { kind: 'ready'; round: number };

/** advance returns the same state until the game considers the current round finished. */
export function createRematchRule<State extends { round: number }>(advance: (current: State) => State) {
  return (current: State, votes: [boolean, boolean], seat: Seat, requestedRound: number): State => {
    if (requestedRound !== current.round) return current;
    const next = advance(current);
    if (next === current) return current;
    votes[seat] = true;
    return votes.every(Boolean) ? next : current;
  };
}
