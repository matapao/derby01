import type { GamePhase } from './model.ts';
import type { ScoringCar } from './scoring.ts';

interface RoundState {
  state: GamePhase;
  cars: ScoringCar[];
  overTimer: number;
  winnerTeam: number;
  teamScores: number[];
}
interface RoundScoring {
  endBurn(car: ScoringCar, keep: boolean): void;
  award(car: ScoringCar | undefined, points: number, label: string, category: string): void;
}
/** Resolve once, by surviving teams rather than number of cars. Bank burns before leaving play. */
export function completeRound(
  state: RoundState,
  between: number,
  winPoints: number,
  scoring: RoundScoring,
): boolean {
  if (state.state !== 'playing') return false;
  const alive = new Set(state.cars.filter((car) => car.alive).map((car) => car.team));
  if (alive.size > 1) return false;
  for (const car of state.cars) scoring.endBurn(car, true);
  state.state = 'over';
  state.overTimer = between;
  state.winnerTeam = alive.size === 1 ? (alive.values().next().value ?? -1) : -1;
  if (state.winnerTeam >= 0) {
    // A surviving team's slot is initialized by round setup. Reject malformed state explicitly.
    const previous = state.teamScores[state.winnerTeam];
    if (previous === undefined) throw new RangeError('Winner has no team score slot');
    state.teamScores[state.winnerTeam] = previous + 1;
    scoring.award(
      state.cars.find((car) => car.alive && car.team === state.winnerTeam),
      winPoints,
      'ROUND WIN',
      'win',
    );
  }
  return true;
}
