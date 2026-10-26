import type { Direction } from './gameplay/input.ts';
import type { GamePhase } from './gameplay/model.ts';

/** Touch gestures have storage separate from keyboard and mouse input. */
export interface TouchInputState<Finger> {
  fingers: Map<number, Finger>;
  presses: Set<string>;
  dirs: Direction[];
  look: { dx: number; dy: number };
  listTap: { x: number; y: number } | null;
  zoomed: boolean;
}

export function releaseTouchInput<Finger>(state: TouchInputState<Finger>): void {
  state.fingers.clear();
  state.presses.clear();
  state.dirs.length = 0;
  state.look.dx = state.look.dy = 0;
  state.listTap = null;
  state.zoomed = false;
}

/** Focus loss can omit pointerup/pointercancel; each device must release its own held state. */
export function bindInputFocusLoss(
  focus: EventTarget,
  visibility: EventTarget,
  isHidden: () => boolean,
  release: () => void,
): () => void {
  const onVisibility = () => {
    if (isHidden()) release();
  };
  focus.addEventListener('blur', release);
  visibility.addEventListener('visibilitychange', onVisibility);
  return () => {
    focus.removeEventListener('blur', release);
    visibility.removeEventListener('visibilitychange', onVisibility);
  };
}

export function gameControlsActive(phase: GamePhase, menuOpen: boolean, hidden: boolean): boolean {
  return !menuOpen && !hidden && (phase === 'countdown' || phase === 'playing' || phase === 'over');
}
