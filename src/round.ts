import { G } from './state.ts';
import { D } from './data.ts';
import { POINTS, award, endBurn } from './score.ts';
import { completeRound } from './gameplay/round.ts';

export function checkRoundEnd(): void {
  completeRound(G, D.rounds.between, POINTS.win, { award, endBurn });
}
