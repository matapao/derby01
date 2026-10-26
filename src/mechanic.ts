import { requireValue } from './required-fields.ts';
import type { BotState } from './car-types.ts';
import { gunAt, gunKey } from './gameplay/guns.ts';
import { createMechanicController, newMechanicState } from './gameplay/mechanic-controller.ts';
import { CAN_FUEL } from './mechanic-data.ts';
import type { LocalHuman, Human } from './human-types.ts';
import type {} from './gameplay/input.ts';
import {
  createMiniGames,
  miniGameHelp,
  isMiniGameKind,
  type MechanicTask,
  type MechanicState,
  type MiniGameKind,
  type KeyNames,
} from './gameplay/minigames.ts';
import { createMiniGameViews, drawMiniGame } from './minigame-view.ts';
import type { Car } from './car.ts';
import * as THREE from 'three';
import { CARDIM, GUN_SEATS, MAX_HP, TAU, TEAMS, TURRETS, _v1, clamp, rand, setPaintDamage } from './core.ts';
import {
  BUMPERS,
  BUMPER_NAMES,
  attachBumper,
  bumperLeft,
  bumperShare,
  dropWheel,
  refitWheel,
} from './car.ts';
import { G } from './state.ts';
import { SMOKE, smokePuff } from './fx.ts';
import { SFX } from './audio.ts';
import { clearWindshieldCracks } from './paint.ts';
import { RADAR, fitRadarHead } from './radar-model.ts';
import { jamGun } from './gun-state.ts';
import { carToWorld } from './gameplay/geometry.ts';
import { DROP_TYPES } from './drop-data.ts';
import { D, onData } from './data.ts';
import { isReplica } from './net/role.ts';
import { askFix, pourInto } from './net/commands.ts';
import { recordCompetitionRepair, recordCompetitionFuel, recordCompetitionPrecision } from './competition.ts';
import {
  BODY_PANELS,
  PANEL_LABELS,
  listPanelRepairs,
  panelRepairId,
  repairPanel,
} from './gameplay/body-damage.ts';

// =====================================================================
//  Car systems: engine, fuel, tyres, axles, fire, bumpers, windshield, radar.
//  The mechanic keeps them running through quick mini-games.
// =====================================================================
const TIRE_NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];

// Tyres wear from hits, hard landings and sliding; at zero they burst. Keep driving on the rim and the wheel comes off.
export function wearTire(car: Car, i: number, amount: number) {
  const s = car.sys;
  if (!s.tires[i] || amount <= 0) return;
  s.tireHp[i] = requireValue(s.tireHp[i]) - amount;
  if (requireValue(s.tireHp[i]) <= 0) breakTire(car, i);
}
export function loseWheel(car: Car, i: number) {
  if (car.sys.wheelOff[i]) return;
  car.sys.wheelOff[i] = true;
  dropWheel(car, i);
  SFX.crash(car.pos, 6);
}
export function breakTire(car: Car, i: number) {
  if (!car.sys.tires[i]) return;
  car.sys.tires[i] = 0;
  car.sys.tireHp[i] = 0;
  const w = requireValue(CARDIM.wheels[i]),
    p = carToWorld(car, w[0], 0.3, w[1], new THREE.Vector3());
  for (let k = 0; k < 6; k++) smokePuff(p.x, p.y, p.z, false, 0.6);
  SFX.crash(p, 5);
}

export function breakAxle(car: Car, i: number) {
  if (!car.sys.axles[i]) return;
  car.sys.axles[i] = 0;
  SFX.clank(car.pos);
}
export function startFire(car: Car, level = 1) {
  if (!car.alive) return;
  car.sys.fire = Math.max(car.sys.fire, level);
  car.sys.fireAge = 0;
}

// What a hit does to the parts behind it.
export function systemsHit(
  car: Car,
  amount: number,
  zone: import('./gameplay/geometry.ts').DamageZone | null,
  cause: import('./gameplay/model.ts').DamageCause,
  local: import('./gameplay/geometry.ts').Vector | null,
  dv: number,
) {
  const s = car.sys;
  const P = D.damage.parts;
  if (zone === 'front') s.engine = Math.max(0, s.engine - amount * P.engine); // the engine sits behind the grille
  if (zone === 'rear' && !s.leak) {
    // fuel tank sits behind the rear ram
    const p = cause === 'gun' ? P.leakGun : dv > P.leakCrashAbove ? P.leakCrash : 0;
    if (Math.random() < p) s.leak = true;
  }
  if (local) {
    CARDIM.wheels.forEach(([wx, wz], i) => {
      const d = Math.hypot(local.x - wx, local.z - wz);
      if (cause === 'gun') {
        if (d < 0.6 && local.y < 0.75) wearTire(car, i, P.tyreGun);
      } else if (cause === 'crash' || cause === 'wall') {
        if (d < 1.1 && dv > P.tyreCrashAbove) wearTire(car, i, (dv - P.tyreCrashAbove) * P.tyreCrash);
      }
    });
  }
  if ((cause === 'crash' || cause === 'wall') && dv > P.axleAbove) {
    const end = zone === 'front' ? 0 : zone === 'rear' ? 1 : -1;
    if (end >= 0 && Math.random() < P.axleChance) breakAxle(car, end);
  }
  if (cause === 'crash' && dv > P.gunJamAbove) {
    const gs = zone === 'front' ? 1 : zone === 'rear' ? 2 : 0;
    if (gs && Math.random() < P.gunJamChance) jamGun(car, gs);
  }
  if (cause === 'gun' && zone === 'rear' && s.leak && Math.random() < P.fireLeakGun) startFire(car, 1);
}

// Every frame: fuel use, fire, and how broken parts change the handling.
export function updateSystems(car: Car, dt: number, fireDamage: (car: Car, amount: number) => void) {
  const s = car.sys,
    M = car.mods;
  if (!car.alive) {
    M.power = 0;
    return;
  }
  const S = D.mechanic.systems;
  if (G.state === 'playing') {
    const burn =
      S.fuel.idle + S.fuel.throttle * Math.abs(car.ctrl.throttle) + (car.boosting ? S.fuel.boost : 0);
    s.fuel = Math.max(0, s.fuel - (burn + (s.leak ? S.fuel.leak : 0)) * dt);
    const low = S.fire.fromEngineBelow;
    if (s.engine < low && !s.fire && Math.random() < dt * S.fire.fromEngine * (1 - s.engine / low))
      startFire(car, 1);
    if (s.fire) {
      s.fireAge += dt;
      if (s.fireAge > (s.leak ? S.fire.growLeaking : S.fire.grow) && s.fire < 3) {
        s.fire++;
        s.fireAge = 0;
      } // it spreads until it's put out
      s.engine = Math.max(0, s.engine - S.fire.engine * s.fire * dt);
      fireDamage(car, S.fire.chassis * s.fire * dt);
    }
  }
  // tyre wear from sliding, and rims grinding down on flats
  if (G.state === 'playing' && car.grounded) {
    const sy = Math.sin(car.yaw),
      cy = Math.cos(car.yaw);
    const vL = car.vel.x * cy - car.vel.z * sy,
      sp = Math.hypot(car.vel.x, car.vel.z);
    if (Math.abs(vL) > 3 || (car.ctrl.handbrake && sp > 5)) {
      wearTire(car, 2, S.tyres.slideRear * dt);
      wearTire(car, 3, S.tyres.slideRear * dt);
      wearTire(car, 0, S.tyres.slideFront * dt);
      wearTire(car, 1, S.tyres.slideFront * dt);
    }
    for (let i = 0; i < 4; i++) {
      if (s.tires[i] || s.wheelOff[i]) continue;
      s.rim[i] = requireValue(s.rim[i]) - sp * S.tyres.rim * dt;
      if (requireValue(s.rim[i]) <= 0) loseWheel(car, i);
    }
  }
  // smashed head- and taillights (they flicker before they go)
  const L = D.car.lights,
    lightsLeft = (dmg: number) => (dmg > L.out ? 0 : dmg > L.flicker ? (Math.random() < 0.85 ? 1 : 0.15) : 1);
  car.paint.userData['u'].lightsF.value = lightsLeft(car.zoneDmg.front);
  car.paint.userData['u'].lightsR.value = lightsLeft(car.zoneDmg.rear);
  const low = (i: number) => (s.wheelOff[i] ? 2 : s.tires[i] ? 0 : 1);
  const flats = low(0) + low(1) + low(2) + low(3);
  const K = S.broken;
  M.power =
    s.fuel <= 0 || s.engine <= 0
      ? 0
      : (K.lowPower + ((1 - K.lowPower) * s.engine) / 100) * (s.axles[1] ? 1 : K.rearAxle);
  M.vmax = Math.max(0.35, 1 - flats * K.flatSpeed);
  M.grip = Math.max(0.4, 1 - flats * K.flatGrip);
  M.steer = s.axles[0] ? 1 : K.frontAxle;
  M.bias = (low(1) + low(3) - low(0) - low(2)) * K.pull; // pulls towards the flat side
  M.wobble = s.axles[0] ? 0 : Math.sin(G.time * 9 + car.idx) * K.wobble;
}

// ---------------------------------------------------------------------
//  Task list (what the mechanic sees), sorted by urgency
// ---------------------------------------------------------------------
/** Which mini-game each job is played with (data/mechanic.json jobs; the tyre job is 'tire' here). */
export const TASK_GAME: Partial<Record<MechanicTask['kind'], MiniGameKind>> = {};
/** How long a bot takes over each job, before its level's factor. */
const BOT_JOB: Record<string, number> = {};
onData(() => {
  for (const [kind, job] of Object.entries(D.mechanic.jobs) as [
    keyof typeof D.mechanic.jobs,
    (typeof D.mechanic.jobs)[keyof typeof D.mechanic.jobs],
  ][]) {
    if (!isMiniGameKind(job.game)) throw new Error(`Unknown minigame ${job.game}`);
    TASK_GAME[kind === 'tyre' ? 'tire' : kind] = job.game;
    BOT_JOB[kind === 'tyre' ? 'tire' : kind] = job.bot;
  }
});
export const BUMPER_URG = { front: 40, rear: 34, left: 30, right: 30 };

export function mechTasks(car: Car) {
  const s = car.sys,
    t: MechanicTask[] = [],
    J = D.mechanic.jobs;
  if (!car.alive) return t;
  if (s.fire)
    t.push({
      id: 'fire',
      kind: 'fire',
      label: `FIRE! Extinguisher (level ${s.fire})`,
      urg: 100 + s.fire * 5,
    });
  if (s.engine <= 0) t.push({ id: 'engine', kind: 'engine', label: 'Engine dead', urg: 92 });
  else if (s.engine < J.engine.below)
    t.push({
      id: 'engine',
      kind: 'engine',
      label: `Engine ${Math.round(s.engine)}%`,
      urg: 30 + (J.engine.below - s.engine) * 0.6,
    });
  if (s.leak) t.push({ id: 'leak', kind: 'leak', label: 'Fuel leak', urg: 68 });
  if (s.fuel <= 0) t.push({ id: 'fuel', kind: 'fuel', label: 'OUT OF FUEL', urg: 90 });
  else if (s.fuel < J.fuel.below)
    t.push({
      id: 'fuel',
      kind: 'fuel',
      label: `Refuel (${Math.round(s.fuel)}%)`,
      urg: s.fuel < 20 ? 74 : 22 + (J.fuel.below - s.fuel) * 0.6,
    });
  s.axles.forEach((ok, i) => {
    if (!ok)
      t.push({
        id: 'axle' + i,
        kind: 'axle',
        idx: i,
        label: `${i ? 'Rear' : 'Front'} axle broken`,
        urg: 62 - i * 4,
      });
  });
  s.tires.forEach((ok, i) => {
    if (s.wheelOff[i])
      t.push({ id: 'tire' + i, kind: 'tire', idx: i, label: `Wheel off ${TIRE_NAMES[i]}!`, urg: 61 });
    else if (!ok)
      t.push({
        id: 'tire' + i,
        kind: 'tire',
        idx: i,
        label: `Flat tyre ${requireValue(TIRE_NAMES[i])}`,
        urg: 55,
      });
    else if (requireValue(s.tireHp[i]) < J.tyre.below)
      t.push({
        id: 'tire' + i,
        kind: 'tire',
        idx: i,
        label: `Worn tyre ${TIRE_NAMES[i]} (${Math.round(requireValue(s.tireHp[i]))}%)`,
        urg: 14 + (J.tyre.below - requireValue(s.tireHp[i])) * 0.6,
      });
  });
  for (const repair of listPanelRepairs(
    car.bodywork,
    BODY_PANELS.filter((name) => car.parts[name]?.parent === car.body),
  )) {
    t.push({
      ...repair,
      id: panelRepairId(repair),
      kind: 'panel',
      label: `Tighten loose ${PANEL_LABELS[repair.name].toLowerCase()}`,
      urg: J.panel.urgency,
    });
  }
  for (const n of BUMPER_NAMES) {
    const p = requireValue(car.bumpers[n]),
      left = bumperLeft(p),
      all = p.pieces.length;
    if (left === all) continue;
    t.push({
      id: 'bumper-' + n,
      kind: 'bumper',
      name: n,
      label: left
        ? `Fit ${requireValue(BUMPERS[n]).label} (${left}/${all} on)`
        : `Fit new ${requireValue(BUMPERS[n]).label}`,
      urg: (BUMPER_URG[n as keyof typeof BUMPER_URG] || 30) - (left / all) * 14,
    });
  }
  const rd = car.radar;
  if (rd.destroyed)
    t.push({ id: 'radar', kind: 'radar', destroyed: true, label: 'Radar knocked off! Rebuild', urg: 64 });
  else if (rd.hp < RADAR.hp * J.radar.below)
    t.push({
      id: 'radar',
      kind: 'radar',
      label: `Radar damaged (${Math.round((rd.hp / RADAR.hp) * 100)}%)`,
      urg: 20 + (1 - rd.hp / RADAR.hp) * 40,
    });
  const ck = car.glass.shield.crack;
  if (ck.level > J.glass.above)
    t.push({
      id: 'glass',
      kind: 'glass',
      label: ck.shattered
        ? 'Windshield shattered!'
        : `Windshield cracked (${Math.round(Math.min(1, ck.level) * 100)}%)`,
      urg: 25 + Math.min(1, ck.level) * 55,
    });
  if (car.hp < s.maxHp - J.chassis.gap)
    t.push({
      id: 'chassis',
      kind: 'chassis',
      label: `Chassis ${Math.round(car.hp)}%`,
      urg: 12 + (100 - car.hp) * 0.3,
    });
  // jobs that use up spares can't be done without them: find a supply drop
  const st = car.stock;
  for (const x of t) {
    const need =
      x.kind === 'fuel' && !st.fuel
        ? 'fuel can'
        : x.kind === 'tire' && !st.tyres
          ? 'spare tyre'
          : x.kind === 'bumper' && !st.bumpers
            ? 'bumper'
            : x.kind === 'glass' && !st.glass
              ? 'windscreen'
              : null;
    if (need) {
      x.need = need;
      x.label += ` · need ${need}`;
      x.urg -= 60;
    }
  }
  return t.sort((a, b) => b.urg - a.urg);
}

export function applyFix(car: Car, task: MechanicTask, byBot: boolean): boolean {
  const s = car.sys;
  const conditionBefore = car.hp + s.engine;
  const fuelBefore = s.fuel;
  switch (task.kind) {
    case 'fire':
      s.fire = 0;
      s.fireAge = 0;
      break;
    case 'engine':
      s.engine = Math.min(100, Math.max(0, s.engine) + D.mechanic.jobs.engine.fix);
      break;
    case 'fuel': // a person pours it in themselves; either way the can is used up
      if (byBot) s.fuel = Math.min(100, s.fuel + CAN_FUEL);
      car.stock.fuel = Math.max(0, car.stock.fuel - 1);
      break;
    case 'leak':
      s.leak = false;
      break;
    case 'axle':
      s.axles[task.idx] = 1;
      break;
    case 'tire':
      car.stock.tyres = Math.max(0, car.stock.tyres - 1);
      s.tires[task.idx] = 1;
      s.tireHp[task.idx] = 100;
      s.rim[task.idx] = 100;
      if (s.wheelOff[task.idx]) {
        refitWheel(car, task.idx);
        s.wheelOff[task.idx] = false;
      }
      break;
    case 'bumper':
      car.stock.bumpers -= attachBumper(car, task.name, false, car.stock.bumpers);
      break;
    case 'radar':
      if (car.radar.destroyed) fitRadarHead(car);
      else car.radar.hp = RADAR.hp;
      break;
    case 'glass':
      car.stock.glass = Math.max(0, car.stock.glass - 1);
      clearWindshieldCracks(car);
      break;
    case 'chassis':
      car.hp = Math.min(s.maxHp, car.hp + D.mechanic.jobs.chassis.fix);
      setPaintDamage(car.paint, (1 - car.hp / MAX_HP) * 0.55);
      break;
    case 'panel':
      if (
        !car.alive ||
        G.state !== 'playing' ||
        !repairPanel(
          car.bodywork,
          BODY_PANELS.filter((name) => car.parts[name]?.parent === car.body),
          task,
          G.time,
          D.mechanic.games.nuts.panelTime,
        )
      )
        return false;
      break;
    default: {
      const exhaustive: never = task;
      throw new Error(`Unknown mechanic task: ${exhaustive}`);
    }
  }
  recordCompetitionRepair(car, Math.max(0, car.hp + s.engine - conditionBefore));
  if (byBot) recordCompetitionFuel(car, Math.max(0, s.fuel - fuelBefore));
  return true;
}

// ---------------------------------------------------------------------
//  Mini-games. update() gets one control frame and returns true when the job is done.
//  Coordinates for drawing are inside the game area (gx, gy, gw, gh) in panel units.
// ---------------------------------------------------------------------
// (list: what the jobs list says instead of "pick · start"; b: '' when there's a button that says it)
function keyNames(dev: string): KeyNames {
  if (dev === 'touch')
    return {
      a: 'the screen',
      b: '',
      lr: '← →',
      dirs: 'the arrows',
      pick: 'Tap a job',
      list: 'Tap a job · tap it again to start',
    };
  if (dev === 'arrows') return { a: 'Enter', b: 'R-Shift', lr: '← →', dirs: 'arrow keys', pick: '↑ ↓' };
  if (dev === 'mouse')
    return { a: 'Left click', b: 'Right click', lr: 'mouse left/right', dirs: 'mouse flicks', pick: 'wheel' };
  if (dev.startsWith('pad'))
    return { a: 'A', b: 'B', lr: 'stick ← →', dirs: 'stick or d-pad', pick: 'stick ↑ ↓' };
  return { a: 'Space', b: 'Shift', lr: 'A / D', dirs: 'W A S D', pick: 'W / S' };
}

export const GAMES = createMiniGames<Car>(D.mechanic.games, () => CAN_FUEL, {
  sound(kind, strength) {
    if (kind === 'crack') SFX.crack(null, strength);
    else SFX[kind]();
  },
  fire: startFire,
  puff: extinguisherPuff,
});
const GAME_VIEWS = createMiniGameViews<Car>(D.mechanic.games, () => CAN_FUEL, {
  arrow: drawArrow,
  flame: drawFlame,
  rect: roundRect,
});

// Direction prompts follow the player's controls: W A S D keycaps for the WASD keyboards,
// arrows for the arrow keys, the d-pad / stick and mouse flicks. (Set by whoever is drawing.)
let PROMPT_DEV = 'arrows';
const KEYCAP = { up: 'W', left: 'A', down: 'S', right: 'D' };
function drawArrow(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: import('./gameplay/input.ts').Direction,
  s: number,
  color: string,
) {
  if (PROMPT_DEV === 'kbm' || PROMPT_DEV === 'wasd') {
    const r = s * 1.25,
      col = new THREE.Color(color),
      dark = col.r + col.g + col.b < 1.2;
    c.fillStyle = color;
    roundRect(c, x - r, y - r, r * 2, r * 2, r * 0.35);
    c.fill();
    c.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = dark ? '#fff3df' : '#1a1620';
    c.font = `800 ${Math.round(r * 1.3)}px ${UI_FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(KEYCAP[dir], x, y + r * 0.06);
    c.textBaseline = 'alphabetic';
    return;
  }
  const a = { up: -Math.PI / 2, right: 0, down: Math.PI / 2, left: Math.PI }[dir];
  c.save();
  c.translate(x, y);
  c.rotate(a);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(s, 0);
  c.lineTo(-s * 0.4, -s * 0.8);
  c.lineTo(-s * 0.4, -s * 0.3);
  c.lineTo(-s, -s * 0.3);
  c.lineTo(-s, s * 0.3);
  c.lineTo(-s * 0.4, s * 0.3);
  c.lineTo(-s * 0.4, s * 0.8);
  c.closePath();
  c.fill();
  c.restore();
}
function drawFlame(c: CanvasRenderingContext2D, x: number, y: number, s: number, t: number) {
  const flick = Math.sin(t * 13) * 0.15 + 1;
  c.fillStyle = '#ff6a1a';
  c.beginPath();
  c.moveTo(x, y - s * 1.4 * flick);
  c.quadraticCurveTo(x + s, y - s * 0.2, x, y + s * 0.5);
  c.quadraticCurveTo(x - s, y - s * 0.2, x, y - s * 1.4 * flick);
  c.fill();
  c.fillStyle = '#ffd24a';
  c.beginPath();
  c.moveTo(x, y - s * 0.8 * flick);
  c.quadraticCurveTo(x + s * 0.5, y, x, y + s * 0.4);
  c.quadraticCurveTo(x - s * 0.5, y, x, y - s * 0.8 * flick);
  c.fill();
}
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

// ---------------------------------------------------------------------
//  People and bots in the mechanic seat
// ---------------------------------------------------------------------
const mechanicController = createMechanicController<Car, Human>({
  games: GAMES,
  tasks: mechTasks,
  canFuel: () => CAN_FUEL,
  gameType(task) {
    const kind = TASK_GAME[task.kind];
    if (!kind) throw new Error(`No minigame configured for ${task.kind}`);
    return kind;
  },
  fix(human, task) {
    if (isReplica() && human.remote === false) {
      askFix(human, task);
      if (task.kind === 'panel') return 'pending';
    } else applyFix(human.car, task, false);
    return undefined;
  },
  fixStatus(human, task) {
    if (task.kind !== 'panel') throw new Error('Only panel repairs await host confirmation');
    const car = human.car;
    const damage = car.bodywork[task.name];
    if (!car.alive || car.parts[task.name]?.parent !== car.body || damage.generation !== task.generation)
      return 'cancelled';
    return damage.looseSince === null ? 'done' : 'waiting';
  },
  poured(human, amount) {
    if (isReplica()) pourInto(human, amount);
    else recordCompetitionFuel(human.car, amount);
  },
  precision: recordCompetitionPrecision,
  sound(kind) {
    SFX[kind]();
  },
});
export const { updateHumanMechanic, dropJob } = mechanicController;

// White powder blowing out of the engine bay while someone works the extinguisher.
function extinguisherPuff(car: Car, dt: number) {
  car.puffT = (car.puffT || 0) - dt;
  if (car.puffT > 0) return;
  car.puffT = 0.05;
  const p = carToWorld(car, rand(-0.5, 0.5), 1.05, rand(1.3, 1.9), _v1);
  SMOKE.emit({
    x: p.x,
    y: p.y,
    z: p.z,
    vx: car.vel.x * 0.6 + rand(-1.4, 1.4),
    vy: rand(0.6, 1.8),
    vz: car.vel.z * 0.6 + rand(-1.4, 1.4),
    life: rand(0.8, 1.4),
    s0: rand(0.4, 0.7),
    s1: rand(1.6, 2.6),
    c0: [0.95, 0.97, 1, 0.6],
    c1: [0.92, 0.94, 0.97, 0],
    drag: 1.6,
  });
}

export function botMechanic(b: BotState, dt: number) {
  const car = b.car;
  if (!car.alive || G.state !== 'playing') return;
  const skill = requireValue(D.bots.levels[G.cfg.botSkill]).mech;
  if (b.job) {
    const job = b.job;
    const task = mechTasks(car).find((t) => t.id === job.id);
    if (!task) {
      b.job = null;
      return;
    }
    if (b.job.kind === 'fire') extinguisherPuff(car, dt);
    if ((b.job.t -= dt) <= 0) {
      applyFix(car, task, true);
      b.job = null;
      b.rest = rand(requireValue(D.bots.rest[0]), requireValue(D.bots.rest[1])) * skill;
    }
    return;
  }
  if ((b.rest = (b.rest || 0) - dt) > 0) return;
  const top = mechTasks(car).find((t) => !t.need);
  if (top) {
    const duration = requireValue(BOT_JOB[top.kind]) * skill * rand(0.85, 1.2);
    b.job = {
      id: top.id,
      kind: top.kind,
      t: top.kind === 'panel' ? Math.max(duration, D.mechanic.games.nuts.panelTime) : duration,
    };
  }
}

// Short status chips for everybody else in the car.
export function carAlerts(car: Car) {
  const s = car.sys;
  const out: [string, 'info' | 'warn' | 'bad'][] = [];
  if (!car.alive) return out;
  if (s.fire) out.push(['FIRE', 'bad']);
  if (s.engine <= 0) out.push(['ENGINE DEAD', 'bad']);
  else if (s.engine < 40) out.push([`ENGINE ${Math.round(s.engine)}%`, 'warn']);
  if (s.fuel <= 0) out.push(['NO FUEL', 'bad']);
  else if (s.fuel < 25) out.push([`FUEL ${Math.round(s.fuel)}%`, 'warn']);
  if (s.leak) out.push(['FUEL LEAK', 'warn']);
  const W = ['FL', 'FR', 'RL', 'RR'];
  const off = W.filter((_n, i) => s.wheelOff[i]),
    flats = W.filter((_n, i) => !s.tires[i] && !s.wheelOff[i]);
  if (off.length) out.push([`WHEEL OFF ${off.join(' ')}`, 'bad']);
  if (flats.length) out.push([`FLAT ${flats.join(' ')}`, 'warn']);
  if (s.tireHp.some((hp, i) => s.tires[i] && hp < 25)) out.push(['WORN TYRES', 'info']);
  if (!s.axles[0]) out.push(['FRONT AXLE', 'warn']);
  if (!s.axles[1]) out.push(['REAR AXLE', 'warn']);
  for (const gs of GUN_SEATS)
    if (gunAt(car, gs).jam) out.push([`${gs === 1 ? 'HOOD' : 'TRUNK'} GUN JAMMED`, 'warn']);
  const bumpers = bumperShare(car),
    ck = car.glass.shield.crack;
  if (bumpers < 1) out.push([`BUMPERS ${Math.round(bumpers * 100)}%`, bumpers < 0.4 ? 'warn' : 'info']);
  if (ck.shattered) out.push(['WINDSHIELD SHATTERED', 'bad']);
  else if (ck.level > 0.4) out.push(['WINDSHIELD CRACKED', 'warn']);
  if (car.radar.destroyed) out.push(['RADAR DOWN', 'bad']);
  else if (car.radar.hp < RADAR.hp * 0.5) out.push(['RADAR DAMAGED', 'warn']);
  return out;
}

// ---------------------------------------------------------------------
//  The mechanic's overview: car schematic, task list and the current job.
//  Drawn on a canvas in 640x360 units, scaled to the player's viewport.
// ---------------------------------------------------------------------
const UI_FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';
function panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title = '') {
  c.fillStyle = 'rgba(14,11,24,0.82)';
  roundRect(c, x, y, w, h, 10);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.14)';
  c.lineWidth = 1;
  c.stroke();
  if (title) {
    c.fillStyle = '#b8a9c8';
    c.font = `600 12px ${UI_FONT}`;
    c.textAlign = 'left';
    c.fillText(title, x + 10, y + 16);
  }
}

// The dash in its 640 x 360 units, scaled into the player's view and centred: the scale, and where it starts.
export function dashFit(vp: import('./hud-types.ts').Viewport) {
  const s = Math.min(vp.w / 640, vp.h / 360);
  return { s, x: (vp.w - 640 * s) / 2, y: (vp.h - 360 * s) / 2 };
}
// The job screen's panel, in those units: the jobs, or the job in hand (on a touch screen the mechanic plays on it).
export const JOBS = { x: 450, y: 124, w: 180, h: 226 };
// The job in hand's own area on it, as drawJob gives it to the game.
export const JOB_AREA = { x: JOBS.x + 8, y: JOBS.y + 28, w: JOBS.w - 16, h: JOBS.h - 66 };

// The mechanic rides up front in the passenger seat with two screens on the dash:
// the left one shows the car (systems, damage, spares), the right one the jobs and the job in hand.
function screenFrame(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number) {
  c.fillStyle = '#121016';
  c.fillRect(x + w / 2 - 9, y + hh - 2, 18, 420 - y - hh); // the mount
  const grd = c.createLinearGradient(x, y, x, y + hh);
  grd.addColorStop(0, '#2b2833');
  grd.addColorStop(1, '#141219');
  c.fillStyle = grd;
  roundRect(c, x, y, w, hh, 12);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.14)';
  c.lineWidth = 1.5;
  c.stroke();
  c.fillStyle = 'rgba(5,9,14,0.94)';
  roundRect(c, x + 6, y + 6, w - 12, hh - 12, 7);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.035)';
  c.beginPath();
  c.moveTo(x + 6, y + 6);
  c.lineTo(x + w * 0.6, y + 6);
  c.lineTo(x + 6, y + hh * 0.55);
  c.closePath();
  c.fill(); // glare
  c.fillStyle = '#4fd06b';
  c.beginPath();
  c.arc(x + w - 12, y + hh - 9, 2, 0, TAU);
  c.fill();
}

export function drawMechanic(h: LocalHuman) {
  const u = h.hud;
  if (!u) return;
  const cv = u.canvas,
    vp = h.vp;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(vp.w * dpr),
    H = Math.round(vp.h * dpr);
  if (cv.width !== W || cv.height !== H) {
    cv.width = W;
    cv.height = H;
  }
  const c = u.ctx;
  PROMPT_DEV = h.device;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  const f = dashFit(vp);
  c.setTransform(dpr * f.s, 0, 0, dpr * f.s, dpr * f.x, dpr * f.y);
  const car = h.car,
    M = h.mech || newMechanicState();
  // left screen: the car
  screenFrame(c, 2, 116, 196, 242);
  c.save();
  c.translate(14, 126);
  c.scale(0.86, 0.86);
  drawSchematic(c, car, 0, 0, 172, 256);
  c.restore();
  // right screen: the jobs, or the job in hand
  screenFrame(c, JOBS.x - 8, JOBS.y - 8, JOBS.w + 16, JOBS.h + 16);
  if (M.pending) {
    panel(c, JOBS.x, JOBS.y, JOBS.w, JOBS.h, 'CONFIRMING REPAIR');
    c.fillStyle = '#ffc24b';
    c.font = `600 18px ${UI_FONT}`;
    c.textAlign = 'center';
    c.fillText('Waiting for host…', JOBS.x + JOBS.w / 2, JOBS.y + 100, JOBS.w - 16);
    c.fillStyle = '#b8a9c8';
    c.font = `400 13px ${UI_FONT}`;
    c.fillText('Checking the tightened panel.', JOBS.x + JOBS.w / 2, JOBS.y + 126, JOBS.w - 16);
  } else if (M.game) drawJob(c, h, M, JOBS.x, JOBS.y, JOBS.w, JOBS.h);
  else {
    drawTaskList(c, h, M, JOBS.x, JOBS.y, JOBS.w, JOBS.h);
    if (M.flash > 0) {
      c.fillStyle = 'rgba(5,9,14,0.85)';
      roundRect(c, 456, 214, 168, 36, 8);
      c.fill();
      c.fillStyle = M.msgBad ? '#ff5468' : '#63e08b';
      c.font = `400 ${M.msgBad ? 15 : 21}px Bungee, Impact, sans-serif`;
      c.textAlign = 'center';
      c.fillText(M.msg, 540, 240, 160);
    }
  }
}

export function drawJam(h: LocalHuman) {
  const u = h.hud;
  if (!u) return;
  const cv = u.canvas,
    vp = h.vp,
    J = h.jamGame;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(vp.w * dpr),
    H = Math.round(vp.h * dpr);
  if (cv.width !== W || cv.height !== H) {
    cv.width = W;
    cv.height = H;
  }
  const c = u.ctx;
  PROMPT_DEV = h.device;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  if (!J) return;
  const s = Math.min(vp.h / 360, Math.max(vp.w / 640, Math.min(1, vp.w / 280))); // (the panel is narrower than the dash: a narrow view still reads it)
  c.setTransform(dpr * s, 0, 0, dpr * s, (dpr * (vp.w - 640 * s)) / 2, (dpr * (vp.h - 360 * s)) / 2);
  const x = 200,
    y = 150,
    w = 240,
    hh = 140,
    k = keyNames(h.device);
  panel(c, x, y, w, hh);
  c.fillStyle = '#ff5468';
  c.font = `400 16px Bungee, Impact, sans-serif`;
  c.textAlign = 'left';
  c.fillText('GUN JAMMED!', x + 10, y + 22);
  GAME_VIEWS.unjam.draw(c, J, x + 8, y + 30, w - 16, hh - 62);
  c.fillStyle = '#fff3df';
  c.font = `600 12px ${UI_FONT}`;
  c.textAlign = 'center';
  c.fillText(GAMES.unjam.help(k, J), x + w / 2, y + hh - 22, w - 16);
  c.fillStyle = '#1b1822';
  c.fillRect(x + 10, y + hh - 13, w - 20, 6);
  c.fillStyle = '#63e08b';
  c.fillRect(x + 10, y + hh - 13, (w - 20) * (J.prog || 0), 6);
}

function drawSchematic(c: CanvasRenderingContext2D, car: Car, x: number, y: number, w: number, h: number) {
  panel(c, x, y, w, h, `CAR #${car.num} · STATUS`);
  const s = car.sys,
    t = performance.now() / 1000,
    blink = Math.sin(t * 8) > 0;
  const k = (h - 86) / 4.8,
    cx = x + 44,
    cy = y + 26 + (h - 86) / 2 + 4;
  const P = (lx: number, lz: number): [number, number] => [cx - lx * k, cy - lz * k];
  // body
  const [bx0, by0] = P(0.86, 2.37);
  c.fillStyle = requireValue(TEAMS[car.team]).ui + '40';
  c.strokeStyle = requireValue(TEAMS[car.team]).ui;
  c.lineWidth = 2;
  roundRect(c, bx0, by0, 1.72 * k, 4.74 * k, 10);
  c.fill();
  c.stroke();
  const line = (a: [number, number], b: [number, number], color: string, width: number, dashed: boolean) => {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dashed ? [4, 3] : []);
    c.beginPath();
    c.moveTo(...P(...a));
    c.lineTo(...P(...b));
    c.stroke();
    c.setLineDash([]);
  };
  const bad = () => (blink ? '#ff5468' : '#5c1a24');
  // axles + tyres
  (
    [
      [0, 1.28],
      [1, -1.12],
    ] satisfies [number, number][]
  ).forEach(([i, z]) =>
    line([0.71, z], [-0.71, z], s.axles[i] ? '#6b7280' : bad(), s.axles[i] ? 3 : 5, !s.axles[i]),
  );
  CARDIM.wheels.forEach(([wx, wz], i) => {
    const [px, py] = P(wx, wz);
    if (s.wheelOff[i]) {
      c.strokeStyle = bad();
      c.lineWidth = 1.5;
      c.setLineDash([3, 2]);
      c.strokeRect(px - 0.13 * k, py - 0.29 * k, 0.26 * k, 0.58 * k);
      c.setLineDash([]);
      return;
    }
    c.fillStyle = !s.tires[i]
      ? bad()
      : requireValue(s.tireHp[i]) < 25
        ? '#8a2a35'
        : requireValue(s.tireHp[i]) < 55
          ? '#7a5a14'
          : '#141418';
    c.fillRect(px - 0.13 * k, py - 0.29 * k, 0.26 * k, 0.58 * k);
  });
  // engine block and fuel tank
  const [ex, ey] = P(0.42, 1.95);
  c.fillStyle = s.engine <= 0 ? bad() : `hsl(${Math.round((s.engine / 100) * 120)},70%,45%)`;
  roundRect(c, ex, ey, 0.84 * k, 0.75 * k, 3);
  c.fill();
  const [fx, fy] = P(0.45, -1.5);
  c.fillStyle = '#1b1822';
  c.fillRect(fx, fy, 0.9 * k, 0.5 * k);
  c.fillStyle = s.fuel < 20 ? bad() : '#ffc24b';
  c.fillRect(fx, fy, 0.9 * k * (s.fuel / 100), 0.5 * k);
  c.strokeStyle = s.leak ? '#ff5468' : '#fff3df';
  c.lineWidth = 1.5;
  c.strokeRect(fx, fy, 0.9 * k, 0.5 * k);
  if (s.leak)
    for (let i = 0; i < 3; i++) {
      c.fillStyle = '#ffc24b';
      c.beginPath();
      c.arc(fx + 0.2 * k + i * 0.25 * k, fy + 0.62 * k + ((t * 30 + i * 9) % 14), 2, 0, TAU);
      c.fill();
    }
  // turrets
  for (const gs of GUN_SEATS) {
    const m = TURRETS[gunKey(gs)].pos,
      [tx, ty] = P(m[0], m[2]);
    c.fillStyle = gunAt(car, gs).jam ? bad() : '#c8cdd4';
    c.beginPath();
    c.arc(tx, ty, 5, 0, TAU);
    c.fill();
  }
  // rubber bumpers round the outline (dashed red = torn off), and the windshield
  const bumperLines: Record<string, [[number, number], [number, number]]> = {
    front: [
      [0.85, 2.45],
      [-0.85, 2.45],
    ],
    rear: [
      [0.85, -2.45],
      [-0.85, -2.45],
    ],
    left: [
      [0.98, 0.9],
      [0.98, -0.8],
    ],
    right: [
      [-0.98, 0.9],
      [-0.98, -0.8],
    ],
  };
  for (const n of BUMPER_NAMES) {
    const p = requireValue(car.bumpers[n]),
      left = bumperLeft(p),
      all = p.pieces.length;
    line(
      requireValue(bumperLines[n])[0],
      requireValue(bumperLines[n])[1],
      left === all ? '#aab2bc' : left ? '#d9a441' : blink ? '#ff5468' : 'rgba(255,84,104,0.35)',
      5,
      left < all,
    );
  }
  const ck = car.glass.shield.crack;
  line(
    [0.65, 0.72],
    [-0.65, 0.72],
    ck.shattered ? bad() : ck.level > 0.4 ? '#d9a441' : '#8fd3ff',
    3,
    ck.level > 0.2,
  );
  {
    const rd = car.radar,
      [rx, ry] = P(0, RADAR.z);
    c.strokeStyle = rd.destroyed ? bad() : rd.hp < RADAR.hp * 0.5 ? '#d9a441' : '#5bff9a';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(rx, ry, 5, 0, TAU);
    c.stroke();
    if (!rd.destroyed) {
      const a = rd.local;
      c.beginPath();
      c.moveTo(rx - Math.cos(a) * 7, ry + Math.sin(a) * 7);
      c.lineTo(rx + Math.cos(a) * 7, ry - Math.sin(a) * 7);
      c.stroke();
    }
  }
  if (s.fire)
    for (let i = 0; i < s.fire + 1; i++) {
      const [px, py] = P(i % 2 ? 0.3 : -0.3, 1.6 - i * 0.9);
      drawFlame(c, px, py, 8, t + i);
    }
  // read-outs
  const bumpers = bumperShare(car);
  const flats = s.tires.filter((v: number) => !v).length,
    wheelsOff = s.wheelOff.filter(Boolean).length,
    axles = s.axles.filter((v: number) => !v).length;
  const worn = s.tireHp.filter((hp: number, i: number) => s.tires[i] && hp < 45).length;
  const rows: [string, string, 'ok' | 'warn' | 'bad'][] = [
    [
      'ENGINE',
      s.engine <= 0 ? 'DEAD' : `${Math.round(s.engine)}%`,
      s.engine <= 0 ? 'bad' : s.engine < 40 ? 'warn' : 'ok',
    ],
    [
      'FUEL',
      `${Math.round(s.fuel)}%${s.leak ? ' LEAK' : ''}`,
      s.fuel <= 0 || s.leak ? 'bad' : s.fuel < 25 ? 'warn' : 'ok',
    ],
    ['FIRE', s.fire ? `LEVEL ${s.fire}` : 'none', s.fire ? 'bad' : 'ok'],
    [
      'TYRES',
      wheelsOff ? `${wheelsOff} wheel off` : flats ? `${flats} flat` : worn ? `${worn} worn` : 'ok',
      wheelsOff ? 'bad' : flats || worn ? 'warn' : 'ok',
    ],
    ['AXLES', axles ? `${axles} broken` : 'ok', axles ? 'warn' : 'ok'],
    ['BUMPERS', `${Math.round(bumpers * 100)}%`, bumpers < 0.4 ? 'bad' : bumpers < 1 ? 'warn' : 'ok'],
    [
      'RADAR',
      car.radar.destroyed ? 'knocked off' : `${Math.round((car.radar.hp / RADAR.hp) * 100)}%`,
      car.radar.destroyed ? 'bad' : car.radar.hp < RADAR.hp * 0.7 ? 'warn' : 'ok',
    ],
    [
      'WINDSHIELD',
      ck.shattered
        ? 'shattered'
        : ck.level > 0.2
          ? `${Math.round(Math.min(1, ck.level) * 100)}% cracked`
          : 'ok',
      ck.shattered ? 'bad' : ck.level > 0.2 ? 'warn' : 'ok',
    ],
  ];
  const colors = { ok: '#63e08b', warn: '#ffc24b', bad: blink ? '#ff5468' : '#ff8a96' };
  rows.forEach(([name, val, lvl], i) => {
    const ry = y + 40 + i * 22;
    c.textAlign = 'left';
    c.fillStyle = '#b8a9c8';
    c.font = `600 11px ${UI_FONT}`;
    c.fillText(name, x + 92, ry);
    c.fillStyle = colors[lvl];
    c.font = `700 14px ${UI_FONT}`;
    c.fillText(val, x + 92, ry + 13, w - 98);
  });
  // chassis
  const hpY = y + h - 30;
  c.fillStyle = '#b8a9c8';
  c.font = `600 12px ${UI_FONT}`;
  c.textAlign = 'left';
  c.fillText(`CHASSIS ${Math.ceil(car.hp)}  (repairable to ${Math.round(s.maxHp)})`, x + 10, hpY, w - 20);
  c.fillStyle = '#1b1822';
  c.fillRect(x + 10, hpY + 6, w - 20, 8);
  c.fillStyle = 'rgba(255,255,255,0.14)';
  c.fillRect(x + 10, hpY + 6, ((w - 20) * s.maxHp) / 100, 8);
  c.fillStyle = car.hp < 30 ? '#ff5468' : car.hp < 60 ? '#ffc24b' : '#63e08b';
  c.fillRect(x + 10, hpY + 6, ((w - 20) * car.hp) / 100, 8);
}

function urgColor(u: number) {
  return u >= 80 ? '#ff5468' : u >= 50 ? '#ff8f3d' : u >= 30 ? '#ffd24a' : '#8f86a0';
}

// Six rows show; the list scrolls to keep the picked job on them.
function listRows(M: MechanicState) {
  const tasks = M.tasks || [],
    rows = Math.min(tasks.length, 6);
  return { rows, top: clamp(tasks.findIndex((t) => t.id === M.sel) - rows + 1, 0, tasks.length - rows) };
}
// The job listed at a point of the job screen (in the dash's units), as drawTaskList lays the rows out, or null.
export function taskAt(M: MechanicState, px: number, py: number) {
  const { rows, top } = listRows(M),
    i = Math.floor((py - JOBS.y - 24) / 23);
  return px >= JOBS.x && px <= JOBS.x + JOBS.w && i >= 0 && i < rows
    ? (M.tasks?.[top + i]?.id ?? null)
    : null;
}

function drawTaskList(
  c: CanvasRenderingContext2D,
  h: LocalHuman,
  M: MechanicState,
  x: number,
  y: number,
  w: number,
  hh: number,
) {
  panel(c, x, y, w, hh, 'JOBS · MOST URGENT FIRST');
  const tasks = M.tasks || [];
  const k = keyNames(h.device);
  c.textAlign = 'left';
  if (!tasks.length) {
    c.fillStyle = '#63e08b';
    c.font = `700 16px ${UI_FONT}`;
    c.fillText('All good. Stand by!', x + 10, y + 46);
  }
  const { rows, top } = listRows(M);
  for (let i = 0; i < rows; i++) {
    const t = requireValue(tasks[top + i]),
      ry = y + 26 + i * 23;
    if (t.id === M.sel) {
      c.fillStyle = 'rgba(255,194,75,0.16)';
      roundRect(c, x + 5, ry - 2, w - 10, 21, 5);
      c.fill();
      c.strokeStyle = '#ffc24b';
      c.lineWidth = 1.5;
      c.stroke();
    }
    c.fillStyle = t.need ? '#4a4458' : urgColor(t.urg);
    c.fillRect(x + 9, ry + 2, 4, 13);
    c.fillStyle = t.need ? '#8f86a0' : '#fff3df';
    c.font = `${t.urg >= 80 ? 700 : 600} 14px ${UI_FONT}`;
    c.fillText(t.label, x + 19, ry + 14, w - 40);
  }
  c.fillStyle = '#b8a9c8';
  c.font = `600 11px ${UI_FONT}`;
  c.textAlign = 'right'; // more above or below
  if (top > 0) c.fillText('▲', x + w - 9, y + 26 + 13);
  if (top + rows < tasks.length) c.fillText('▼', x + w - 9, y + 26 + (rows - 1) * 23 + 13);
  c.textAlign = 'left';
  // spares on board
  const st = h.car.stock,
    sy = y + hh - 52;
  c.fillStyle = 'rgba(255,255,255,0.07)';
  roundRect(c, x + 6, sy - 14, w - 12, 36, 5);
  c.fill();
  c.font = `700 13px ${UI_FONT}`;
  (
    [
      [`${st.fuel} fuel can`, DROP_TYPES.fuel.ui, st.fuel],
      [`${st.tyres} tyre`, DROP_TYPES.tyre.ui, st.tyres],
      [`${st.bumpers} bumper`, DROP_TYPES.bumper.ui, st.bumpers],
      [`${st.glass} windscreen`, DROP_TYPES.glass.ui, st.glass],
    ] as const
  ).forEach(([txt, col, n], i) => {
    c.fillStyle = n ? col : '#ff5468';
    c.fillText(txt, x + 12 + (i % 2) * ((w - 20) / 2), sy + 1 + (i >> 1) * 16, (w - 28) / 2);
  });
  c.fillStyle = '#b8a9c8';
  c.font = `600 12px ${UI_FONT}`;
  c.fillText(k.list ?? `${k.pick}: pick · ${k.a}: start`, x + 10, y + hh - 10, w - 20);
}

function drawJob(
  c: CanvasRenderingContext2D,
  h: LocalHuman,
  M: MechanicState,
  x: number,
  y: number,
  w: number,
  hh: number,
) {
  const k = keyNames(h.device),
    g = M.game;
  if (!g) return;
  panel(c, x, y, w, hh);
  c.fillStyle = '#ffc24b';
  c.font = `400 15px Bungee, Impact, sans-serif`;
  c.textAlign = 'left';
  c.fillText(g.label.toUpperCase(), x + 10, y + 21, w - 78);
  c.fillStyle = '#b8a9c8';
  c.font = `600 11px ${UI_FONT}`;
  c.textAlign = 'right';
  if (k.b) c.fillText(`${k.b}: drop it`, x + w - 8, y + 19, 62);
  drawMiniGame(GAME_VIEWS, g, c, x + 8, y + 28, w - 16, hh - 66, h.car);
  c.fillStyle = '#fff3df';
  c.font = `600 13px ${UI_FONT}`;
  c.textAlign = 'center';
  c.fillText(miniGameHelp(GAMES, g, k), x + w / 2, y + hh - 24, w - 16);
  c.fillStyle = '#1b1822';
  c.fillRect(x + 10, y + hh - 14, w - 20, 7);
  c.fillStyle = '#63e08b';
  c.fillRect(x + 10, y + hh - 14, (w - 20) * clamp(g.prog || 0, 0, 1), 7);
}
