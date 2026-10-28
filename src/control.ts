import { requireValue } from './required-fields.ts';
import { bindInputFocusLoss } from './browser-input-lifecycle.ts';
import { gunAt, isGunSeat, gunKey } from './gameplay/guns.ts';
import { usesMouse } from './device-mode.ts';
import type { Human, LocalHuman } from './human-types.ts';
import { resetSeatState } from './gameplay/participants.ts';
import type { BotState, Car, Occupant } from './car-types.ts';
import {
  Input,
  finishInputFrame,
  releaseInput,
  type ControlFrame,
  type Direction,
} from './gameplay/input.ts';
import * as THREE from 'three';
import { GUN, MAX_HP, TURRETS, _v1, clamp, damp, pick, rand, wrapPi } from './core.ts';
import { NAV, OBSTACLES, arenaNormal, arenaSDF, navStep, renderer, segmentClear } from './world.ts';
import { refreshOccupantVisuals } from './car.ts';
import { G } from './state.ts';
import { SFX } from './audio.ts';
import { _dir, _muz, gunMuzzle } from './combat.ts';
import { aimDir } from './gameplay/geometry.ts';
import { GAMES, dropJob, updateHumanMechanic } from './mechanic.ts';
import { dropWanted } from './drops.ts';
import { lifecycle } from './lifecycle.ts';
import { sendCrew } from './net/crew.ts';
import { endTouchFrame, nextDevice, notePads, readTouch, useDevice } from './touch.ts';
import { D, onData } from './data.ts';

// =====================================================================
//  Input
// =====================================================================
const GAME_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Slash',
  'Period',
  'Comma',
  'Enter',
  'Tab',
]);
window.addEventListener('keydown', (e) => {
  if (!e.repeat) Input.pressed.add(e.code);
  Input.keys.add(e.code);
  if (G.state !== 'menu' && GAME_KEYS.has(e.code) && !(e.target instanceof HTMLSelectElement))
    e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  Input.keys.delete(e.code);
  if (e.key === 'Meta') Input.keys.clear(); // (macOS sends no keyup for keys let go while Cmd is down)
});
// Leaving the window (or the tab): nothing stays held down. (Online the host's game runs on while hidden.)
bindInputFocusLoss(
  window,
  document,
  () => document.hidden,
  () => releaseInput(Input),
);
window.addEventListener('mousemove', (e) => {
  Input.mouse.dx += e.movementX || 0;
  Input.mouse.dy += e.movementY || 0;
});
renderer.domElement.addEventListener('mousedown', (e) => {
  Input.mouse.buttons |= 1 << e.button;
  Input.mouse.pressed |= 1 << e.button;
  if (
    usesMouse() &&
    document.pointerLockElement !== renderer.domElement &&
    (G.state === 'playing' || G.state === 'countdown')
  ) {
    renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  }
  SFX.init();
});
window.addEventListener('mouseup', (e) => {
  Input.mouse.buttons &= ~(1 << e.button);
});
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    Input.mouse.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  },
  { passive: false },
);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) G.lockLostAt = performance.now();
  if (!document.pointerLockElement && usesMouse() && (G.state === 'playing' || G.state === 'countdown'))
    lifecycle().pauseGame(true);
});

export function pollPads() {
  let list: (Gamepad | null)[] = [];
  try {
    list = navigator.getGamepads?.() ?? [];
  } catch {
    /* a frame on another site that isn't allowed gamepads */
  }
  for (let i = 0; i < 4; i++) {
    const p = list[i],
      was = Input.pads[i];
    Input.pads[i] =
      p && p.connected
        ? {
            buttons: p.buttons.map((b) => b.value > 0.5 || b.pressed),
            values: p.buttons.map((b) => b.value),
            axes: [...p.axes],
            id: p.id,
          }
        : null;
    // a pad that has just (re)appeared in a round: what's held down on it isn't a press (on the start screen it joins with one)
    Input.padPrev[i] = was
      ? was.buttons
      : Input.pads[i] && G.state !== 'menu'
        ? (Input.pads[i]?.buttons ?? [])
        : [];
  }
  notePads(); // (the last device used wins: touch.ts)
}
export function endInputFrame() {
  finishInputFrame(Input);
  endTouchFrame();
}

let MOUSE_SENS = 0.0022,
  KEY_YAW = 1.7,
  KEY_PITCH = 1.1,
  PAD_YAW = 2.8,
  PAD_PITCH = 1.8; // (data/controls.json)
onData(() => {
  const c = D.controls;
  MOUSE_SENS = c.mouse;
  KEY_YAW = c.keys.yaw;
  KEY_PITCH = c.keys.pitch;
  PAD_YAW = c.pad.yaw;
  PAD_PITCH = c.pad.pitch;
});
const deadzone = (v: number, d = D.controls.pad.deadzone) =>
  Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);

// Turn a device into one control frame. Each role reads the fields it needs.
export function readControls(h: LocalHuman, dt: number): ControlFrame {
  const out: ControlFrame = {
    throttle: 0,
    steer: 0,
    handbrake: false,
    boost: false,
    orbit: 0,
    dYaw: 0,
    dPitch: 0,
    fire: false,
    zoom: false,
    switchP: false,
    seatTo: null,
    camP: false,
    // mechanic: stick/keys, one-shot direction taps, action (A) and cancel (B); a job tapped on a touch screen
    x: 0,
    y: 0,
    tap: null,
    a: false,
    aP: false,
    bP: false,
    wheel: 0,
    mdx: 0,
    mdy: 0,
    pick: null,
  };
  if (G.menuOpen) return out; // online the game goes on behind the menu: hands off meanwhile
  const k = (c: string) => Input.keys.has(c),
    kp = (c: string) => Input.pressed.has(c);
  const m = Input.mouse;
  const dev = h.device;
  if (dev === 'kbm' || dev === 'wasd' || dev === 'arrows') {
    const K =
      dev === 'arrows'
        ? {
            up: 'ArrowUp',
            down: 'ArrowDown',
            left: 'ArrowLeft',
            right: 'ArrowRight',
            act: 'Enter',
            alt: 'ShiftRight',
            seat: 'Period',
            cam: 'Comma',
          }
        : {
            up: 'KeyW',
            down: 'KeyS',
            left: 'KeyA',
            right: 'KeyD',
            act: 'Space',
            alt: 'ShiftLeft',
            seat: 'KeyC',
            cam: 'KeyV',
          };
    const ax = (k(K.right) ? 1 : 0) - (k(K.left) ? 1 : 0),
      ay = (k(K.up) ? 1 : 0) - (k(K.down) ? 1 : 0);
    out.throttle = ay;
    out.steer = ax;
    out.handbrake = k(K.act);
    out.boost = k(K.alt);
    out.switchP = kp(K.seat);
    out.seatTo =
      kp('Digit1') || kp('Numpad1')
        ? 1
        : kp('Digit2') || kp('Numpad2')
          ? 3
          : kp('Digit3') || kp('Numpad3')
            ? 2
            : null;
    out.camP = kp(K.cam);
    out.x = ax;
    out.y = ay;
    out.tap = kp(K.up) ? 'up' : kp(K.down) ? 'down' : kp(K.left) ? 'left' : kp(K.right) ? 'right' : null;
    out.a = k(K.act);
    out.aP = kp(K.act);
    out.bP = kp(K.alt);
    if (dev === 'kbm') {
      out.dYaw = -m.dx * MOUSE_SENS;
      out.dPitch = -m.dy * MOUSE_SENS;
      out.fire = !!(m.buttons & 1) || (h.seat !== 0 && k(K.act));
      out.zoom = !!(m.buttons & 4);
      out.orbit = m.dx;
      out.a ||= !!(m.buttons & 1);
      out.aP ||= !!(m.pressed & 1);
      out.bP ||= !!(m.pressed & 4);
      out.wheel = m.wheel;
      out.mdx = m.dx;
      out.mdy = m.dy;
    } else {
      out.dYaw = -ax * KEY_YAW * dt;
      out.dPitch = ay * KEY_PITCH * dt;
      out.fire = k(K.act);
    }
  } else if (dev === 'mouse') {
    out.dYaw = -m.dx * MOUSE_SENS;
    out.dPitch = -m.dy * MOUSE_SENS;
    out.fire = !!(m.buttons & 1);
    out.switchP = !!(m.pressed & 2);
    if (h.seat === 0) h.mouseSteer = clamp((h.mouseSteer || 0) + m.dx * 0.004, -1, 1); // (steering only builds up in the driver's seat)
    out.steer = h.mouseSteer || 0;
    out.throttle = (m.buttons & 1 ? 1 : 0) - (m.buttons & 4 ? 1 : 0);
    out.x = clamp(m.dx * 0.08, -1, 1);
    out.y = clamp(-m.dy * 0.08, -1, 1);
    out.mdx = m.dx;
    out.mdy = m.dy;
    out.wheel = m.wheel;
    out.a = !!(m.buttons & 1);
    out.aP = !!(m.pressed & 1);
    out.bP = !!(m.pressed & 4);
    // a quick flick of the mouse counts as a direction press
    h.flickCd = Math.max(0, (h.flickCd || 0) - dt);
    if (h.flickCd <= 0 && Math.max(Math.abs(m.dx), Math.abs(m.dy)) > D.controls.flick) {
      out.tap = Math.abs(m.dx) > Math.abs(m.dy) ? (m.dx > 0 ? 'right' : 'left') : m.dy > 0 ? 'down' : 'up';
      h.flickCd = 0.18;
    }
  } else if (dev === 'touch') {
    readTouch(h, out, dt);
  } else if (dev.startsWith('pad')) {
    const n = +requireValue(dev[3]);
    const p = Input.pads[n];
    if (!p) return out;
    const prev = Input.padPrev[n] || [];
    const btn = (i: number) => !!p.buttons[i],
      bp = (i: number) => !!p.buttons[i] && !prev[i],
      val = (i: number) => p.values[i] || 0;
    const lx = deadzone(p.axes[0] || 0),
      ly = deadzone(p.axes[1] || 0),
      rx = deadzone(p.axes[2] || 0),
      ry = deadzone(p.axes[3] || 0);
    out.steer = Math.sign(lx) * Math.abs(lx) ** 1.4;
    out.throttle = val(7) - val(6) || (btn(12) ? 1 : 0) - (btn(13) ? 1 : 0);
    out.handbrake = btn(0);
    out.boost = btn(2);
    out.camP = bp(1);
    out.switchP = bp(3);
    out.orbit = rx * 14;
    const useR = Math.abs(rx) + Math.abs(ry) > 0.05;
    const sx = useR ? rx : lx,
      sy = useR ? ry : ly;
    out.dYaw = -Math.sign(sx) * Math.abs(sx) ** 1.6 * PAD_YAW * dt;
    out.dPitch = -Math.sign(sy) * Math.abs(sy) ** 1.6 * PAD_PITCH * dt;
    out.fire = val(7) > 0.3;
    out.zoom = val(6) > 0.3;
    out.x = lx || (btn(15) ? 1 : 0) - (btn(14) ? 1 : 0);
    out.y = -ly || (btn(12) ? 1 : 0) - (btn(13) ? 1 : 0);
    // direction taps from the d-pad, or from the stick being pushed over (with a little hysteresis)
    const mag = Math.max(Math.abs(lx), Math.abs(ly));
    let stick: Direction | null =
      mag > 0.6 ? (Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'right' : 'left') : ly > 0 ? 'down' : 'up') : null;
    if (!stick && mag > 0.35) stick = h.stickDir || null;
    out.tap = bp(12)
      ? 'up'
      : bp(13)
        ? 'down'
        : bp(14)
          ? 'left'
          : bp(15)
            ? 'right'
            : stick && stick !== h.stickDir
              ? stick
              : null;
    h.stickDir = stick;
    out.a = btn(0);
    out.aP = bp(0);
    out.bP = bp(1);
  }
  return out;
}

// =====================================================================
//  Seats, people and bots
// =====================================================================
export function defaultGunYaw(car: Car, s: number) {
  return car.yaw + TURRETS[gunKey(s)].center;
}
export function clampGunToArc(car: Car, s: number) {
  const g = gunAt(car, s),
    t = TURRETS[gunKey(s)];
  const rel = clamp(wrapPi(g.yaw - car.yaw - t.center), -t.arc, t.arc);
  g.yaw = wrapPi(car.yaw + t.center + rel);
  g.pitch = clamp(g.pitch, D.car.turrets[gunKey(s)].pitchMin, D.car.turrets[gunKey(s)].pitchMax);
}

// Into the next seat a bot has (or a chosen turret/engine view): the bot takes the seat this player left.
export function switchSeat(h: Human, target?: number) {
  const car = h.car;
  if (!car.alive) return;
  const humanCrew = [1, 2, 3].some((s) => s !== h.seat && car.occ[s]?.kind === 'human');
  const candidates =
    target !== undefined
      ? target >= 1 && target <= 3
        ? [target]
        : []
      : [1, 2, 3].map((k) => (h.seat + k) % 4);
  for (const s of candidates) {
    if (s === h.seat) continue;
    if (car.occ[s]?.kind === 'human') continue;
    if (s > 0 && humanCrew) continue;
    if (isGunSeat(h.seat)) {
      const oldGun = gunAt(car, h.seat);
      oldGun.firing = false;
      oldGun.zoom = 0;
    }
    dropJob(h); // (a can poured from is used up)
    car.occ[s] = requireValue(car.occ[h.seat]);
    car.occ[h.seat] = makeBot(car, h.seat);
    resetSeatState(h, car, s);
    if (isGunSeat(s)) {
      const g = gunAt(car, s);
      g.yaw = defaultGunYaw(car, s);
      g.pitch = 0.02;
    }
    h.hintT = 6;
    refreshOccupantVisuals(car);
    SFX.click();
    sendCrew();
    return;
  }
}

export function updateHumanControls(h: LocalHuman, dt: number) {
  const dev = nextDevice(h); // the last device used wins
  if (dev !== h.device) useDevice(h, dev);
  const ctl = readControls(h, dt);
  h.orbit = ctl.orbit;
  if (h.dead || !h.car.alive) {
    if (ctl.switchP) cycleWatch(h);
    return;
  }
  const car = h.car;
  if (h.seat !== 0 && ctl.seatTo && ctl.seatTo !== h.seat) {
    switchSeat(h, ctl.seatTo);
    return;
  }
  if (ctl.switchP) {
    switchSeat(h);
    return;
  }
  if (h.seat === 0) {
    if (G.state === 'playing')
      Object.assign(car.ctrl, {
        throttle: ctl.throttle,
        steer: ctl.steer,
        handbrake: ctl.handbrake,
        boost: ctl.boost,
      });
    else Object.assign(car.ctrl, { throttle: 0, steer: ctl.steer, handbrake: true, boost: false });
    if (ctl.camP) h.camMode = h.camMode === 'chase' ? 'cockpit' : 'chase';
    const lookBack = !h.device.startsWith('pad') && ctl.zoom;
    h.lookBack = lookBack;
    const gunSeat = lookBack ? 2 : 1,
      otherSeat = lookBack ? 1 : 2;
    const g = gunAt(car, gunSeat),
      other = gunAt(car, otherSeat);
    other.firing = false;
    other.zoom = 0;
    if (lookBack) h.relYawB = clamp((h.relYawB ?? 0) + ctl.dYaw, -TURRETS.trunk.arc, TURRETS.trunk.arc);
    else h.relYawF = clamp((h.relYawF ?? 0) + ctl.dYaw, -TURRETS.hood.arc, TURRETS.hood.arc);
    gunAt(car, 1).yaw = wrapPi(car.yaw + TURRETS.hood.center + (h.relYawF ?? 0));
    gunAt(car, 2).yaw = wrapPi(car.yaw + TURRETS.trunk.center + (h.relYawB ?? 0));
    g.pitch += ctl.dPitch;
    clampGunToArc(car, 1);
    clampGunToArc(car, 2);
    g.firing = G.state === 'playing' && ctl.fire && !g.jam;
    if (g.jam) {
      const J = (h.jamGame ||= GAMES.unjam.init());
      if (GAMES.unjam.update(J, ctl, dt)) {
        g.jam = false;
        g.overheat = false;
        g.heat = Math.min(g.heat, 0.45);
        h.jamGame = null;
        SFX.ok();
      }
    } else h.jamGame = null;
  } else if (h.seat === 3) {
    updateHumanMechanic(h, ctl, dt);
  } else {
    const g = gunAt(car, h.seat);
    const z = g.zoom > 0.5 ? 0.45 : 1;
    g.yaw += ctl.dYaw * z;
    g.pitch += ctl.dPitch * z;
    clampGunToArc(car, h.seat);
    g.firing = ctl.fire && !g.jam;
    // a jammed gun has to be cleared by its own gunner
    if (g.jam) {
      const J = (h.jamGame ||= GAMES.unjam.init());
      if (GAMES.unjam.update(J, ctl, dt)) {
        g.jam = false;
        g.overheat = false;
        g.heat = Math.min(g.heat, 0.45);
        h.jamGame = null;
        SFX.ok();
      }
    } else h.jamGame = null;
    g.zoom = damp(g.zoom, ctl.zoom ? 1 : 0, 14, dt);
  }
}

export function cycleWatch(h: LocalHuman) {
  const alive = G.cars.filter((c) => c.alive);
  if (!alive.length) return;
  const i = h.watch ? alive.indexOf(h.watch) : -1;
  h.watch = requireValue(alive[(i + 1) % alive.length]);
  h.watchT = 99;
}

// ---------------------------------------------------------------------
//  Bots
// ---------------------------------------------------------------------
const BOT_SKILL = D.bots.levels; // easy, normal, hard (data/bots.json)
export function makeBot(car: Car, seat: number): Occupant {
  return {
    kind: 'bot',
    bot: {
      car,
      seat,
      target: null,
      retarget: 0,
      stuckT: 0,
      reverseT: 0,
      burstT: 0,
      think: 0,
      wob: new THREE.Vector3(),
      wobT: 0,
      aim: new THREE.Vector3(),
      job: null,
      rest: 0,
    },
  };
}

function chooseTarget(car: Car) {
  let best = null,
    bestScore = Infinity;
  for (const c of G.cars) {
    if (c === car || !c.alive || c.team === car.team) continue;
    const dx = c.pos.x - car.pos.x,
      dz = c.pos.z - car.pos.z;
    const d = Math.hypot(dx, dz);
    const ang = Math.abs(wrapPi(Math.atan2(dx, dz) - car.yaw));
    const human = c.occ.some((o) => o && o.kind === 'human') ? -6 : 0;
    const score = d + ang * 7 + (c.hp / MAX_HP) * 10 + human + rand(0, 8);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// Somewhere open to drive to when a bot is wedged: a waypoint it can see, not too near.
function escapePoint(car: Car) {
  const opts: [number, number][] = [];
  if (NAV)
    for (const [x, z] of NAV.nodes) {
      const d = Math.hypot(x - car.pos.x, z - car.pos.z);
      if (d > 7 && d < 45 && segmentClear(car.pos.x, car.pos.z, x, z, 0.6)) opts.push([x, z]);
    }
  const [x, z] = opts.length ? pick(opts) : NAV.nodes.length ? pick(NAV.nodes) : [0, 0];
  return { x, z };
}

export function botDrive(b: BotState, dt: number) {
  const car = b.car,
    c = car.ctrl,
    S = requireValue(BOT_SKILL[G.cfg.botSkill]);
  if (G.state !== 'playing' || !car.alive) {
    Object.assign(c, { throttle: 0, steer: 0, handbrake: true, boost: false });
    b.prog = null;
    return;
  }
  b.retarget -= dt;
  if (b.retarget <= 0 || !b.target || !b.target.alive) {
    b.target = chooseTarget(car);
    b.retarget = rand(1.5, 3.5);
  }
  const speed = Math.hypot(car.vel.x, car.vel.z);
  let tx,
    tz,
    dist = 30;
  if (b.target) {
    const t = b.target;
    dist = Math.hypot(t.pos.x - car.pos.x, t.pos.z - car.pos.z);
    const lead = clamp(dist / Math.max(speed + 6, 12), 0, 1.3);
    tx = t.pos.x + t.vel.x * lead;
    tz = t.pos.z + t.vel.z * lead;
  } else {
    const ph = G.time * 0.21 + car.idx * 1.7;
    tx = Math.sin(ph) * 28;
    tz = Math.cos(ph * 0.8) * 16;
  }
  // a supply drop it needs (or one right nearby) beats chasing someone far away
  b.dropT = (b.dropT || 0) - dt;
  if (b.dropT <= 0) {
    b.dropT = 0.5;
    b.drop = dropWanted(car);
  }
  if (b.drop && b.drop.taken < 0) {
    const dd = Math.hypot(b.drop.x - car.pos.x, b.drop.z - car.pos.z);
    if (!b.target || dd < dist * 1.4) {
      tx = b.drop.x;
      tz = b.drop.z;
      dist = Math.max(dd, 15);
    }
  }
  // no progress for a while (wedged by a post, a tree, a corner): head for open space for a few seconds
  if (!b.prog || Math.hypot(car.pos.x - b.prog.x, car.pos.z - b.prog.z) > 5)
    b.prog = { x: car.pos.x, z: car.pos.z, t: G.time };
  else if (G.time - b.prog.t > 6 && car.mods.power > 0 && !(b.escape && b.escape.until > G.time)) {
    b.escape = { ...escapePoint(car), until: G.time + 4 };
    b.prog.t = G.time;
  }
  if (b.escape && b.escape.until > G.time) {
    tx = b.escape.x;
    tz = b.escape.z;
    dist = 30;
  }
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  // steer around walls and obstacles that are right ahead
  const look = 4 + speed * 0.55;
  // find a way round buildings (maps with a waypoint graph)
  if (NAV && (b.target || b.drop)) {
    b.navT = (b.navT || 0) - dt;
    if (b.navT <= 0) {
      b.navT = 0.4;
      b.wp = navStep(car.pos.x, car.pos.z, tx, tz);
    }
    if (b.wp) {
      tx = b.wp[0];
      tz = b.wp[1];
      dist = Math.max(dist, 20);
    }
  }
  // heading for the edge of the arena: turn back inwards
  const ax = car.pos.x + sy * look,
    az = car.pos.z + cy * look;
  if (arenaSDF(ax, az) > -2.5 && dist > 6) {
    arenaNormal(ax, az, _v1);
    tx = ax - _v1.x * 14;
    tz = az - _v1.z * 14;
  }
  for (const o of OBSTACLES) {
    if (o.down) continue;
    const dx = o.x - car.pos.x,
      dz = o.z - car.pos.z;
    const ahead = dx * sy + dz * cy,
      side = dx * cy - dz * sy;
    const r = (o.kind === 'circle' ? o.r : Math.max(o.hw, o.hl)) + 1.6;
    if (ahead > 0 && ahead < look + 3 && Math.abs(side) < r) {
      const push = side > 0 ? -1 : 1;
      tx += cy * push * 6;
      tz -= sy * push * 6;
    }
  }
  for (const o of G.cars) {
    if (o === car || o.team !== car.team || !o.alive) continue; // don't ram friends
    const dx = o.pos.x - car.pos.x,
      dz = o.pos.z - car.pos.z;
    const ahead = dx * sy + dz * cy,
      side = dx * cy - dz * sy;
    if (ahead > 0 && ahead < 10 && Math.abs(side) < 2.6) {
      const push = side > 0 ? -1 : 1;
      tx += cy * push * 8;
      tz -= sy * push * 8;
    }
  }
  const desired = Math.atan2(tx - car.pos.x, tz - car.pos.z);
  const diff = wrapPi(desired - car.yaw);
  let steer = clamp(-diff * 2.3, -1, 1);
  let throttle = S.throttle;
  let handbrake = Math.abs(diff) > 1.0 && Math.abs(diff) < 2.6 && speed > 13;
  let boost = Math.abs(diff) < 0.14 && dist > 12 && dist < 50 && car.boostFuel > 0.3 && G.cfg.botSkill > 0;
  if (Math.abs(diff) > 2.2 && dist < 12 && speed < 10) {
    throttle = -1;
    steer = -steer * 0.8;
  }
  // a car with no fuel or engine won't move however hard you press: don't count that as stuck
  // derby move: when shoving nose to nose gets nowhere, back off and ram again at speed
  if (b.target && dist < 7 && speed < 4 && throttle > 0) b.pushT = (b.pushT || 0) + dt;
  else b.pushT = Math.max(0, (b.pushT || 0) - dt);
  if (b.pushT > 0.9 && !(b.reverseT > 0)) {
    b.reverseT = rand(0.9, 1.4);
    b.revDir = 1;
    b.pushT = 0;
  }
  if (Math.abs(throttle) > 0.5 && speed < 1.3 && car.mods.power > 0) b.stuckT += dt;
  else b.stuckT = Math.max(0, b.stuckT - dt * 2);
  if (b.stuckT > 1.1) {
    // stuck again straight away (a corner, a tight bay): back out longer on full lock, then go for something else
    b.stuckN = G.time - (b.stuckAt ?? -99) < 6 ? (b.stuckN || 0) + 1 : 0;
    b.stuckAt = G.time;
    b.reverseT = rand(0.8, 1.3) * (1 + Math.min(b.stuckN, 3) * 0.35);
    b.stuckT = 0;
    b.revDir = Math.sign(throttle) || 1;
    b.revSteer = b.stuckN > 0 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    if (b.stuckN > 2) {
      b.escape = { ...escapePoint(car), until: G.time + 4 };
      b.wp = null;
    } // a third time: get clear first
  }
  if (b.reverseT > 0) {
    b.reverseT -= dt;
    throttle = -(b.revDir ?? 1);
    steer = b.revSteer || -steer;
    handbrake = false;
    boost = false;
    // backing into something: stop pushing and pull out on the other lock (a three-point turn)
    b.revBlock = speed < 0.5 ? (b.revBlock || 0) + dt : 0;
    if (b.revBlock > 0.5) {
      b.reverseT = 0;
      b.revBlock = 0;
      b.fwdT = 0.9;
      b.fwdSteer = -Math.sign(steer || 1);
    }
  } else if ((b.fwdT ?? 0) > 0) {
    b.fwdT = (b.fwdT ?? 0) - dt;
    throttle = b.revDir || 1;
    steer = b.fwdSteer ?? 0;
    handbrake = false;
    boost = false;
  }
  // paint on the windshield: it can't see where it's going
  const blind =
    Math.max(0, car.glass.shield.cover - 0.25) + Math.max(0, car.glass.shield.crack.level - 0.35) * 0.9; // paint or cracks
  if (blind > 0) {
    steer = clamp(steer + Math.sin(G.time * 2.3 + car.idx * 1.7) * blind * 1.1, -1, 1);
    throttle *= 1 - blind * 0.35;
  }
  Object.assign(c, { throttle, steer, handbrake, boost });
}

function pickGunTarget(car: Car, s: number) {
  const t = TURRETS[gunKey(s)];
  let best = null,
    bestD = 75;
  for (const c of G.cars) {
    if (c === car || !c.alive || c.team === car.team) continue;
    const dx = c.pos.x - car.pos.x,
      dz = c.pos.z - car.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD) continue;
    if (Math.abs(wrapPi(Math.atan2(dx, dz) - car.yaw - t.center)) > t.arc + 0.1) continue; // out of this turret's reach
    best = c;
    bestD = d;
  }
  return best;
}

export function botGun(b: BotState, dt: number) {
  const car = b.car,
    s = b.seat,
    g = gunAt(car, s),
    S = requireValue(BOT_SKILL[G.cfg.botSkill]);
  if (!car.alive) {
    g.firing = false;
    return;
  }
  // bots clear a jam after a few seconds of fiddling
  if (g.jam) {
    b.unjamT = (b.unjamT ?? rand(requireValue(D.bots.unjam[0]), requireValue(D.bots.unjam[1])) * S.mech) - dt;
    if (b.unjamT <= 0) {
      g.jam = false;
      g.overheat = false;
      g.heat = 0.4;
      b.unjamT = null;
    }
  }
  b.think -= dt;
  if (b.think <= 0) {
    b.think = S.react * rand(0.7, 1.3);
    b.target = pickGunTarget(car, s);
  }
  b.wobT -= dt;
  if (b.wobT <= 0) {
    b.wobT = rand(0.3, 0.8);
    const painted = car.glass[gunKey(s)].cover; // paint on its sight spoils its aim
    b.wob.set(rand(-1, 1), rand(-0.4, 0.6), rand(-1, 1)).multiplyScalar(S.wobble * (1 + painted * 3));
  }
  const muzzle = gunMuzzle(car, s, _muz);
  let wantYaw = defaultGunYaw(car, s),
    wantPitch = 0.02,
    dist = 0;
  const t = b.target;
  if (t && t.alive) {
    dist = muzzle.distanceTo(t.pos);
    const tt = dist / GUN.speed;
    b.aim.set(t.pos.x + t.vel.x * tt, t.pos.y + 0.8 + t.vel.y * tt, t.pos.z + t.vel.z * tt).add(b.wob);
    wantYaw = Math.atan2(b.aim.x - muzzle.x, b.aim.z - muzzle.z);
    wantPitch = Math.atan2(b.aim.y - muzzle.y, Math.hypot(b.aim.x - muzzle.x, b.aim.z - muzzle.z));
  }
  const rate = S.turn * dt;
  g.yaw = wrapPi(g.yaw + clamp(wrapPi(wantYaw - g.yaw), -rate, rate));
  g.pitch += clamp(wantPitch - g.pitch, -rate, rate);
  clampGunToArc(car, s);
  const err = Math.abs(wrapPi(wantYaw - g.yaw)) + Math.abs(wantPitch - g.pitch);
  b.burstT -= dt;
  if (b.burstT < -0.5) b.burstT = S.burst * rand(0.6, 1.4);
  // better bots ease off before the gun overheats and jams
  g.firing =
    !!t &&
    t.alive &&
    !g.jam &&
    G.state === 'playing' &&
    err < 0.1 &&
    dist < S.range &&
    b.burstT > 0 &&
    g.heat < S.coolAt;
  aimDir(g.yaw, g.pitch, _dir);
  g.aimPoint.copy(muzzle).addScaledVector(_dir, Math.max(dist, 20));
}
