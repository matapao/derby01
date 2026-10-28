import type { BurnState, DriveControls, GamePhase, GameStats } from './model.ts';

export interface ScoringCar {
  team: number;
  alive: boolean;
  grounded: boolean;
  yaw: number;
  yawRate: number;
  vel: { x: number; z: number };
  ctrl: DriveControls;
  mods: { power: number };
  lastHitBy: ScoringCar | null;
  lastHitTime: number;
  burn?: BurnState;
}
export interface ScoreState {
  state: GamePhase;
  time: number;
  points: number[];
  stats: GameStats;
}
export interface ScoreRules {
  damage: number;
  radar: number;
  burn: {
    min: number;
    rate: number;
    grow: number;
    max: number;
    grace: number;
    crash: number;
    announce: number;
  };
}
export type ScoreEvent =
  | { kind: 'award'; car: ScoringCar; points: number; label: string }
  | { kind: 'radar'; source: ScoringCar; victim: ScoringCar; points: number }
  | { kind: 'radarMark'; car: ScoringCar }
  | { kind: 'burnFeed'; car: ScoringCar; seconds: number; points: number }
  | { kind: 'burnEnd'; car: ScoringCar; keep: boolean };
export const newBurn = (): BurnState => ({ t: 0, off: 0, on: false, kick: -99 });

/** Rules mutate only their supplied state. Presentation is a synchronous, explicit dependency. */
export function createScoring(state: ScoreState, rules: ScoreRules, emit: (event: ScoreEvent) => void) {
  const burnPoints = (seconds: number): number =>
    Math.round(rules.burn.rate * seconds + rules.burn.grow * seconds * seconds);
  function addPoints(team: number, points: number, category: string): void {
    const previous = state.points[team];
    if (previous === undefined) throw new RangeError('Team has no points slot');
    state.points[team] = previous + points;
    const stats = (state.stats.points ||= {});
    stats[category] = (stats[category] || 0) + points;
  }
  function award(car: ScoringCar | null | undefined, points: number, label?: string, category = ''): void {
    if (!car || !Number.isFinite(points) || points <= 0) return;
    addPoints(car.team, points, category || 'other');
    if (label) emit({ kind: 'award', car, points, label });
  }
  function scoreDamage(victim: ScoringCar, amount: number, source: ScoringCar | null): void {
    if (
      !source ||
      source === victim ||
      source.team === victim.team ||
      state.state !== 'playing' ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return;
    addPoints(source.team, amount * rules.damage, 'damage');
  }
  function scoreRadar(victim: ScoringCar, source: ScoringCar | null): void {
    const by = source || (state.time - victim.lastHitTime < 2.5 ? victim.lastHitBy : null);
    if (!by || by === victim || by.team === victim.team || state.state !== 'playing') return;
    award(by, rules.radar, 'RADAR OUT', 'hs');
    emit({ kind: 'radar', source: by, victim, points: rules.radar });
    emit({ kind: 'radarMark', car: by });
  }
  function endBurn(car: ScoringCar, keep: boolean): void {
    const burn = car.burn;
    if (!burn?.on) return;
    if (burn.t >= rules.burn.min) {
      if (keep) {
        const points = burnPoints(burn.t);
        award(car, points, `BURN ${burn.t.toFixed(1)}s`, 'burn');
        if (points >= rules.burn.announce) emit({ kind: 'burnFeed', car, seconds: burn.t, points });
      }
      emit({ kind: 'burnEnd', car, keep });
    }
    burn.on = false;
    burn.t = 0;
    burn.off = 0;
  }
  function updateBurn(car: ScoringCar, dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const burn = (car.burn ||= newBurn());
    if (!car.alive || state.state !== 'playing') {
      burn.on = false;
      burn.t = 0;
      burn.off = 0;
      return;
    }
    const sy = Math.sin(car.yaw),
      cy = Math.cos(car.yaw),
      control = car.ctrl;
    const forward = car.vel.x * sy + car.vel.z * cy,
      lateral = car.vel.x * cy - car.vel.z * sy;
    const speed = Math.hypot(car.vel.x, car.vel.z),
      slip = Math.atan2(Math.abs(lateral), Math.abs(forward));
    if (
      car.grounded &&
      ((control.handbrake && speed > 1.5) ||
        (control.throttle > 0.7 && Math.abs(control.steer) > 0.75 && speed > 5))
    )
      burn.kick = state.time;
    const drift = speed > 4 && slip > (burn.on ? 0.2 : 0.35) && control.throttle > 0.2;
    const donut = speed > 1.5 && Math.abs(car.yawRate) > 1.3 && control.throttle > 0.5;
    if (car.grounded && car.mods.power > 0 && (drift || donut) && (burn.on || state.time - burn.kick < 0.6)) {
      burn.on = true;
      burn.off = 0;
      burn.t += dt;
      if (burn.t >= rules.burn.max) endBurn(car, true);
    } else if (burn.on && (burn.off += dt) > rules.burn.grace) endBurn(car, true);
  }
  function burnCrash(car: ScoringCar, impact: number): void {
    if (car.burn?.on && impact > rules.burn.crash) endBurn(car, false);
  }
  return { award, scoreDamage, scoreRadar, burnPoints, updateBurn, endBurn, burnCrash };
}
