// Compile-time regression tests. An accidental widening to `any` makes @ts-expect-error fail.
import type { VehicleState, GamePhase, GameStats } from '../../src/gameplay/model.ts';
import type { ControlFrame } from '../../src/gameplay/input.ts';
import type { ScoreEvent } from '../../src/gameplay/scoring.ts';
import type { Car } from '../../src/car.ts';

export function checkContracts(car: Car, vehicle: VehicleState, frame: ControlFrame, stats: GameStats): void {
  // @ts-expect-error arbitrary car properties must not be silently accepted
  car.hitPionts = 100;
  // @ts-expect-error health must remain numeric even on the legacy car
  car.hp = 'broken';
  // @ts-expect-error driver input must remain numeric
  car.ctrl.throttle = true;
  // @ts-expect-error tyre health is not text
  vehicle.sys.tireHp[0] = 'flat';
  // @ts-expect-error firing is a boolean
  vehicle.gun[1].firing = 1;
  // @ts-expect-error direction taps are a closed set
  frame.tap = 'north';
  // @ts-expect-error score totals cannot become strings
  stats.points = { damage: 'lots' };
  // @ts-expect-error gameplay phases are a closed set
  const phase: GamePhase = 'typo';
  // @ts-expect-error presentation events must carry their required fields
  const event: ScoreEvent = { kind: 'award' };
  void phase;
  void event;
}
