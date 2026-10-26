import type { ControlFrame } from './input.ts';
import type { ActiveGame } from './minigames.ts';
export interface PrecisionAction {
  kind: 'nuts' | 'hammer' | 'radar' | 'glass' | 'dents' | 'unjam';
  before: number;
}
/** Count only actual timed/directional attempts. Continuous games have no invented precision score. */
export function precisionAction(game: ActiveGame, input: ControlFrame, dt: number): PrecisionAction | null {
  switch (game.type) {
    case 'hammer':
    case 'radar':
      return input.aP ? { kind: game.type, before: game.hits } : null;
    case 'glass':
      return game.phase === 1 && input.aP ? { kind: game.type, before: game.hits } : null;
    case 'nuts':
    case 'unjam':
      return input.tap && game.lock <= dt && game.i < game.seq.length
        ? { kind: game.type, before: game.i }
        : null;
    case 'dents':
      return input.tap ? { kind: game.type, before: game.n } : null;
    case 'glue':
    case 'dial':
    case 'spray':
    case 'pour':
      return null;
    default: {
      const exhaustive: never = game;
      throw new Error(`Unknown precision game: ${exhaustive}`);
    }
  }
}
export function precisionResult(action: PrecisionAction, game: ActiveGame): number {
  if (action.kind !== game.type) throw new Error('Minigame changed during an action');
  switch (game.type) {
    case 'hammer':
    case 'radar':
    case 'glass':
      return game.hits > action.before ? 1 : 0;
    case 'nuts':
    case 'unjam':
      return game.i > action.before ? 1 : 0;
    case 'dents':
      return game.n > action.before ? 1 : 0;
    default:
      throw new Error('Continuous game has no timing precision action');
  }
}
