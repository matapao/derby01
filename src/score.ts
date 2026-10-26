import { G } from './state.ts';
import { D } from './data.ts';
import { createScoring, type ScoreEvent } from './gameplay/scoring.ts';
import { recordCompetitionBurn } from './competition.ts';

export const POINTS = D.points;
let presentation: ((event: ScoreEvent) => void) | null = null;
/** main.ts wires effects before boot. Rules never import their presentation or the renderer. */
export function bindScorePresentation(emit: (event: ScoreEvent) => void): void {
  presentation = emit;
}
const scoring = createScoring(G, POINTS, (event) => {
  if (event.kind === 'burnEnd') {
    const car = G.cars.find((car) => car === event.car);
    if (car) recordCompetitionBurn(car, car.burn?.t ?? 0);
  }
  if (!presentation) throw new Error('Score presentation must be bound before starting the game');
  presentation(event);
});
export const { award, scoreDamage, scoreRadar, burnPoints, updateBurn, endBurn, burnCrash } = scoring;
