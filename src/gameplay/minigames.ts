import type tuning from '../../data/mechanic.json';
import type { ControlFrame, Direction } from './input.ts';
import { clamp, TAU, wrapPi } from './numbers.ts';
import type { PanelRepair } from './body-damage.ts';

export type MiniGameKind = keyof GameStates;
const GAME_KINDS: Record<MiniGameKind, true> = {
  glue: true,
  nuts: true,
  hammer: true,
  dial: true,
  spray: true,
  pour: true,
  dents: true,
  radar: true,
  glass: true,
  unjam: true,
};
export const isMiniGameKind = (value: unknown): value is MiniGameKind =>
  typeof value === 'string' && Object.hasOwn(GAME_KINDS, value);
interface Progress {
  prog: number;
}
export interface GameStates {
  glue: Progress & { heat: number; burn: number; sparkT: number; good: boolean };
  nuts: Progress & {
    seq: Direction[];
    i: number;
    lock: number;
    bad: number;
    mash: number;
    panel: boolean;
    elapsed: number;
    minTime: number;
    taps: number;
    pause: number;
  };
  hammer: Progress & {
    need: number;
    hits: number;
    t: number;
    x: number;
    speed: number;
    zone: number;
    w: number;
    flash: number;
    miss: number;
  };
  dial: Progress & {
    a: number;
    v: number;
    drift: number;
    driftT: number;
    target: number;
    w: number;
    in: boolean;
  };
  spray: Progress & {
    flames: { x: number; y: number; hp: number }[];
    cx: number;
    cy: number;
    sprayT: number;
    pressure: number;
    empty: boolean;
    spraying?: boolean;
  };
  pour: Progress & { spill: number; held: boolean; glugT: number; can: number; pouring?: boolean };
  dents: Progress & { need: number; n: number; next: 'left' | 'right'; bump: number };
  radar: Progress & { need: number; hits: number; a: number; blip: number; flash: number; miss: number };
  glass: Progress & {
    phase: number;
    knocks: number;
    x: number;
    dir: number;
    hits: number;
    flash: number;
    miss: number;
  };
  unjam: Progress & { seq: Direction[]; i: number; lock: number; bad: number; kick: number };
}
interface TaskBase {
  id: string;
  label: string;
  urg: number;
  need?: string;
}
export type MechanicTask = TaskBase &
  (
    | { kind: 'fire' | 'engine' | 'fuel' | 'leak' | 'glass' | 'chassis' }
    | { kind: 'axle' | 'tire'; idx: number }
    | { kind: 'bumper'; name: string }
    | ({ kind: 'panel' } & PanelRepair)
    | { kind: 'radar'; destroyed?: boolean }
  );
export interface JobMeta {
  taskId: string;
  task: MechanicTask;
  label: string;
}
export type ActiveGame = { [K in MiniGameKind]: GameStates[K] & JobMeta & { type: K } }[MiniGameKind];
export interface PendingRepair {
  task: MechanicTask;
  elapsed: number;
  retry: number;
}
export interface MechanicState {
  sel: string | null;
  game: ActiveGame | null;
  pending: PendingRepair | null;
  flash: number;
  msg: string;
  msgBad?: boolean;
  tasks?: MechanicTask[];
}
export interface KeyNames {
  a: string;
  b: string;
  lr: string;
  dirs: string;
  pick: string;
  list?: string;
}
export interface MiniCar {
  sys: { fuel: number; fire: number };
}
export type MiniSound = 'fail' | 'weld' | 'click' | 'clang' | 'spray' | 'glug' | 'beepOk' | 'crack';
export interface MiniEffects<C extends MiniCar> {
  sound(kind: MiniSound, strength?: number): void;
  fire(car: C, level: number): void;
  puff(car: C, dt: number): void;
}
export interface GameDefinition<K extends MiniGameKind, C extends MiniCar> {
  help(keys: KeyNames, game: GameStates[K]): string;
  init: K extends 'unjam' ? () => GameStates[K] : (task: MechanicTask, car: C) => GameStates[K];
  update: K extends 'pour' | 'spray'
    ? (state: GameStates[K], input: ControlFrame, dt: number, car: C) => boolean
    : (state: GameStates[K], input: ControlFrame, dt: number, car?: C) => boolean;
}
export type MiniGames<C extends MiniCar> = { [K in MiniGameKind]: GameDefinition<K, C> };
export type MiniRules = typeof tuning.games;

/** Rules are independent of game state, drawing and sound. Randomness/effects are supplied explicitly. */
export function createMiniGames<C extends MiniCar>(
  rules: MiniRules,
  canFuel: () => number,
  effects: MiniEffects<C>,
  random: () => number = () => Math.random(),
): MiniGames<C> {
  const rand = (a: number, b: number): number => a + random() * (b - a);
  const pick = <T>(list: readonly T[]): T => {
    if (!list.length) throw new RangeError('Cannot pick from an empty minigame choice list');
    const index = Math.floor(random() * list.length);
    if (index < 0 || index >= list.length || !Number.isInteger(index))
      throw new RangeError('Random source must return a value in [0,1)');
    return list[index]!;
  };
  const DIRS: readonly Direction[] = ['up', 'right', 'down', 'left'];
  return {
    glue: {
      help: (k) => `Hold ${k.a} to heat the glue · keep it in the green`,
      init: () => ({ prog: 0, heat: rules.glue.start, burn: 0, sparkT: 0, good: false }),
      update(g, inp, dt) {
        const Q = rules.glue;
        g.heat = clamp(g.heat + (inp.a ? Q.heat : -Q.cool) * dt, 0, 1.2);
        g.burn = Math.max(0, g.burn - dt);
        if (g.heat >= 1) {
          g.heat = 0.3;
          g.prog = Math.max(0, g.prog - Q.burn);
          g.burn = 0.7;
          effects.sound('fail');
        }
        // the seam keeps fusing while the metal is in the green, faster with the torch on
        const inBand = g.heat > Q.low && g.heat < Q.high;
        g.good = inBand && inp.a;
        if (inBand) g.prog += (inp.a ? Q.held : Q.idle) * dt;
        if (g.good && (g.sparkT -= dt) <= 0) {
          g.sparkT = 0.1;
          effects.sound('weld');
        }
        return g.prog >= 1;
      },
    },
    nuts: {
      help: (k, g) =>
        g.panel
          ? g.i < g.seq.length
            ? `Tighten the hinges: press ${k.dirs} as shown`
            : g.mash < g.taps
              ? `Tap ${k.a} to secure the panel`
              : 'Checking the tightened panel…'
          : g.i < g.seq.length
            ? `Undo the nuts: press ${k.dirs} as shown`
            : `Tap ${k.a} to bolt on the spare`,
      init: (task) => ({
        prog: 0,
        seq: Array.from({ length: task.kind === 'panel' ? rules.nuts.panelNuts : rules.nuts.nuts }, () =>
          pick(DIRS),
        ),
        i: 0,
        lock: 0,
        bad: 0,
        mash: 0,
        panel: task.kind === 'panel',
        elapsed: 0,
        minTime: task.kind === 'panel' ? rules.nuts.panelTime : 0,
        taps: task.kind === 'panel' ? rules.nuts.panelTaps : rules.nuts.taps,
        pause: task.kind === 'panel' ? rules.nuts.panelPause : rules.nuts.pause,
      }),
      update(g, inp, dt) {
        g.elapsed += dt;
        g.lock -= dt;
        g.bad -= dt;
        if (g.i < g.seq.length) {
          if (inp.tap && g.lock <= 0) {
            if (inp.tap === g.seq[g.i]) {
              g.i++;
              effects.sound('click');
            } else {
              g.lock = g.bad = g.pause;
              effects.sound('fail');
            }
          }
        } else if (inp.aP && g.mash < g.taps) {
          g.mash++;
          effects.sound('clang');
        }
        const taps = g.taps;
        g.prog = (g.i + (g.mash * 2) / taps) / (g.seq.length + 2);
        if (g.minTime > 0) g.prog = Math.min(g.prog, g.elapsed / g.minTime);
        return g.mash >= taps && g.elapsed >= g.minTime;
      },
    },
    hammer: {
      help: (k) => `Tap ${k.a} when the marker is in the green`,
      init: (task) => ({
        prog: 0,
        need: task.kind === 'axle' ? rules.hammer.axleHits : rules.hammer.hits,
        hits: 0,
        t: rand(0, 2),
        x: 0,
        speed: rules.hammer.speed,
        zone: rand(0.2, 0.8),
        w: rules.hammer.zone,
        flash: 0,
        miss: 0,
      }),
      update(g, inp, dt) {
        g.t = (g.t + g.speed * dt) % 2; // there and back
        g.x = 1 - Math.abs(g.t - 1);
        g.flash -= dt;
        g.miss -= dt;
        if (inp.aP) {
          if (Math.abs(g.x - g.zone) < g.w / 2) {
            g.hits++;
            g.flash = 0.3;
            g.zone = rand(0.15, 0.85);
            effects.sound('clang');
          } else {
            g.speed = Math.min(2.8, g.speed * rules.hammer.speedup);
            g.miss = 0.3;
            effects.sound('fail');
          } // a miss speeds it up (to a point)
        }
        g.prog = g.hits / g.need;
        return g.hits >= g.need;
      },
    },
    dial: {
      help: (k) => `Hold the needle in the green (${k.lr})`,
      init: () => ({
        prog: 0,
        a: rand(-0.7, 0.7),
        v: 0,
        drift: 0,
        driftT: 0,
        target: rand(-0.35, 0.35),
        w: rules.dial.zone,
        in: false,
      }),
      update(g, inp, dt) {
        const Q = rules.dial;
        if ((g.driftT -= dt) <= 0) {
          g.drift = rand(-1, 1) * Q.drift;
          g.driftT = rand(0.25, 0.6);
        }
        g.v += (g.drift + inp.x * Q.push) * dt;
        g.v *= Math.exp(-Q.damping * dt);
        g.a += g.v * dt;
        if (g.a > 1) {
          g.a = 1;
          g.v = 0;
        } else if (g.a < -1) {
          g.a = -1;
          g.v = 0;
        }
        g.in = Math.abs(g.a - g.target) < g.w / 2;
        g.prog = clamp(g.prog + (g.in ? Q.fill : -Q.drain) * dt, 0, 1);
        return g.prog >= 1;
      },
    },
    spray: {
      // the fire extinguisher: aim the nozzle at the base of the flames and spray in bursts
      help: (k) => `Aim at the base of the flames · hold ${k.a} to spray`,
      init: (_task, car) => {
        const n = 1 + car.sys.fire;
        return {
          prog: 0,
          flames: Array.from({ length: n }, (_, i) => ({
            x: 0.2 + ((i + 0.5) / n) * 0.6 + rand(-0.05, 0.05),
            y: rand(0.58, 0.7),
            hp: 1,
          })),
          cx: 0.5,
          cy: 0.42,
          sprayT: 0,
          pressure: 1,
          empty: false,
        };
      },
      update(g, inp, dt, car) {
        g.cx = clamp(g.cx + inp.x * 0.9 * dt + (inp.mdx || 0) * 0.004, 0.06, 0.94);
        g.cy = clamp(g.cy - inp.y * 0.9 * dt + (inp.mdy || 0) * 0.004, 0.12, 0.9);
        g.spraying = inp.a && !g.empty;
        // the bottle runs dry if you hold it down too long; let go and the pressure builds up again
        const Q = rules.spray;
        if (g.spraying) {
          g.pressure -= dt * Q.use;
          if (g.pressure <= 0) {
            g.pressure = 0;
            g.empty = true;
          }
        } else {
          g.pressure = Math.min(1, g.pressure + dt * Q.refill);
          if (g.empty && g.pressure > 0.35) g.empty = false;
        }
        for (const f of g.flames) {
          if (f.hp <= 0) continue;
          const atBase = Math.hypot((f.x - g.cx) * 1.5, f.y - g.cy) < Q.reach; // the base of the fire is what puts it out
          const atFlame = Math.abs(f.x - g.cx) < 0.09 && g.cy < f.y && g.cy > f.y - 0.32; // the flames themselves, not much
          if (g.spraying && atBase) f.hp -= Q.base * dt;
          else if (g.spraying && atFlame) f.hp -= Q.flame * dt;
          else f.hp = Math.min(1, f.hp + Q.regrow * dt);
        }
        if (g.spraying && (g.sprayT -= dt) <= 0) {
          g.sprayT = 0.16;
          effects.sound('spray');
        }
        if (g.spraying && car) effects.puff(car, dt);
        const left = g.flames.filter((f) => f.hp > 0).length;
        g.prog = 1 - left / g.flames.length;
        return left === 0;
      },
    },
    pour: {
      help: (k) => `Hold ${k.a} to pour · let go when it's full (don't spill!)`,
      init: () => ({ prog: 0, spill: 0, held: false, glugT: 0, can: canFuel() }),
      update(g, inp, dt, car) {
        const s = car.sys;
        g.spill -= dt;
        g.pouring = inp.a && g.can > 0;
        if (g.pouring) {
          const d = Math.min(g.can, rules.pour.rate * dt);
          g.can -= d;
          s.fuel += d;
          if (s.fuel > 100) {
            g.can = Math.max(0, g.can - rules.pour.spill);
            s.fuel = 90;
            g.spill = 0.9;
            effects.sound('fail');
            if (Math.random() < rules.pour.fireChance) effects.fire(car, 1);
          }
          if ((g.glugT -= dt) <= 0) {
            g.glugT = 0.22;
            effects.sound('glug');
          }
        }
        g.prog = Math.max(s.fuel / 100, 1 - g.can / canFuel());
        // done when you stop with a full tank, or when the can is empty
        const done = (g.held && !inp.a && s.fuel >= rules.pour.full) || g.can <= 0;
        g.held = inp.a;
        return done;
      },
    },
    dents: {
      help: (k) => `Alternate ${k.lr} as fast as you can`,
      init: () => ({
        prog: 0,
        need: rules.dents.taps,
        n: 0,
        next: pick(['left', 'right'] as const),
        bump: 0,
      }),
      update(g, inp, dt) {
        g.bump -= dt;
        if (inp.tap === g.next) {
          g.n++;
          g.next = g.next === 'left' ? 'right' : 'left';
          g.bump = 0.12;
          effects.sound('clang');
        }
        g.prog = g.n / g.need;
        return g.n >= g.need;
      },
    },
    radar: {
      help: (k) => `Tap ${k.a} as the sweep crosses the blip`,
      init: (task) => ({
        prog: 0,
        need: task.kind === 'radar' && task.destroyed ? rules.radar.rebuild : rules.radar.repair,
        hits: 0,
        a: 0,
        blip: rand(1, 5),
        flash: 0,
        miss: 0,
      }),
      update(g, inp, dt) {
        g.a = (g.a + dt * rules.radar.sweep) % TAU;
        g.flash -= dt;
        g.miss -= dt;
        if (inp.aP) {
          if (Math.abs(wrapPi(g.a - g.blip)) < rules.radar.window) {
            g.hits++;
            g.flash = 0.3;
            g.blip = (g.a + rand(1.5, 4.5)) % TAU;
            effects.sound('beepOk');
          } else {
            g.miss = 0.3;
            effects.sound('fail');
          }
        }
        g.prog = g.hits / g.need;
        return g.hits >= g.need;
      },
    },
    glass: {
      help: (k, g) =>
        g.phase === 0 ? `Tap ${k.a} to knock out the broken glass` : `Tap ${k.a} when the new pane lines up`,
      init: () => ({ prog: 0, phase: 0, knocks: 0, x: -1, dir: 1, hits: 0, flash: 0, miss: 0 }),
      update(g, inp, dt) {
        g.flash -= dt;
        g.miss -= dt;
        if (g.phase === 0) {
          const knocks = rules.glass.knocks;
          if (inp.aP) {
            g.knocks++;
            g.flash = 0.15;
            effects.sound('crack', 1.2);
            if (g.knocks >= knocks) g.phase = 1;
          }
          g.prog = (g.knocks / knocks) * 0.5;
          return false;
        }
        const Q = rules.glass;
        g.x += g.dir * Q.slide * dt;
        if (g.x > 1) {
          g.x = 1;
          g.dir = -1;
        } else if (g.x < -1) {
          g.x = -1;
          g.dir = 1;
        }
        if (inp.aP) {
          if (Math.abs(g.x) < Q.window) {
            g.hits++;
            g.flash = 0.25;
            effects.sound('clang');
            g.x = g.dir > 0 ? -1 : 1;
          } else {
            g.miss = 0.3;
            effects.sound('fail');
          }
        }
        g.prog = 0.5 + (g.hits / Q.hits) * 0.5;
        return g.hits >= Q.hits;
      },
    },
    unjam: {
      help: (k) => `Clear the jam: press ${k.dirs} in order`,
      init: () => ({
        prog: 0,
        seq: Array.from({ length: rules.unjam.steps }, () => pick(DIRS)),
        i: 0,
        lock: 0,
        bad: 0,
        kick: 0,
      }),
      update(g, inp, dt) {
        g.lock -= dt;
        g.bad -= dt;
        g.kick -= dt;
        if (inp.tap && g.lock <= 0) {
          if (inp.tap === g.seq[g.i]) {
            g.i++;
            g.kick = 0.12;
            effects.sound('clang');
          } else {
            g.lock = g.bad = rules.unjam.pause;
            effects.sound('fail');
          }
        }
        g.prog = g.i / g.seq.length;
        return g.i >= g.seq.length;
      },
    },
  };
}

export function startMiniGame<C extends MiniCar, K extends MiniGameKind>(
  games: MiniGames<C>,
  kind: K,
  task: MechanicTask,
  car: C,
): Extract<ActiveGame, { type: K }>;
export function startMiniGame<C extends MiniCar>(
  games: MiniGames<C>,
  kind: MiniGameKind,
  task: MechanicTask,
  car: C,
): ActiveGame {
  const meta: JobMeta = { task, taskId: task.id, label: task.label };
  switch (kind) {
    case 'glue':
      return { ...meta, type: kind, ...games.glue.init(task, car) };
    case 'nuts':
      return { ...meta, type: kind, ...games.nuts.init(task, car) };
    case 'hammer':
      return { ...meta, type: kind, ...games.hammer.init(task, car) };
    case 'dial':
      return { ...meta, type: kind, ...games.dial.init(task, car) };
    case 'spray':
      return { ...meta, type: kind, ...games.spray.init(task, car) };
    case 'pour':
      return { ...meta, type: kind, ...games.pour.init(task, car) };
    case 'dents':
      return { ...meta, type: kind, ...games.dents.init(task, car) };
    case 'radar':
      return { ...meta, type: kind, ...games.radar.init(task, car) };
    case 'glass':
      return { ...meta, type: kind, ...games.glass.init(task, car) };
    case 'unjam':
      return { ...meta, type: kind, ...games.unjam.init() };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown minigame: ${exhaustive}`);
    }
  }
}
export function advanceMiniGame<C extends MiniCar>(
  games: MiniGames<C>,
  game: ActiveGame,
  input: ControlFrame,
  dt: number,
  car: C,
): boolean {
  if (!Number.isFinite(dt) || dt <= 0) return false;
  switch (game.type) {
    case 'glue':
      return games.glue.update(game, input, dt, car);
    case 'nuts':
      return games.nuts.update(game, input, dt, car);
    case 'hammer':
      return games.hammer.update(game, input, dt, car);
    case 'dial':
      return games.dial.update(game, input, dt, car);
    case 'spray':
      return games.spray.update(game, input, dt, car);
    case 'pour':
      return games.pour.update(game, input, dt, car);
    case 'dents':
      return games.dents.update(game, input, dt, car);
    case 'radar':
      return games.radar.update(game, input, dt, car);
    case 'glass':
      return games.glass.update(game, input, dt, car);
    case 'unjam':
      return games.unjam.update(game, input, dt, car);
    default: {
      const exhaustive: never = game;
      throw new Error(`Unknown minigame: ${exhaustive}`);
    }
  }
}
export function miniGameHelp<C extends MiniCar>(
  games: MiniGames<C>,
  game: ActiveGame,
  keys: KeyNames,
): string {
  switch (game.type) {
    case 'glue':
      return games.glue.help(keys, game);
    case 'nuts':
      return games.nuts.help(keys, game);
    case 'hammer':
      return games.hammer.help(keys, game);
    case 'dial':
      return games.dial.help(keys, game);
    case 'spray':
      return games.spray.help(keys, game);
    case 'pour':
      return games.pour.help(keys, game);
    case 'dents':
      return games.dents.help(keys, game);
    case 'radar':
      return games.radar.help(keys, game);
    case 'glass':
      return games.glass.help(keys, game);
    case 'unjam':
      return games.unjam.help(keys, game);
    default: {
      const exhaustive: never = game;
      throw new Error(`Unknown minigame: ${exhaustive}`);
    }
  }
}
