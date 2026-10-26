/**
 * The host's snapshot of the cars, 30 times a second, and the controls the other screens send back.
 * Both are binary and travel unreliably: the next one replaces a lost one.
 */
import type { Reader, Writer } from '/zirbel-net.js';

export const SNAP_VERSION = 2;

/** What the round is doing (the order is part of the wire format). */
export const STATES = ['menu', 'countdown', 'playing', 'over', 'paused'] as const;
export type RoundState = (typeof STATES)[number];

export interface GunSnap {
  yaw: number;
  pitch: number;
  loft: number;
  heat: number;
  recoil: number;
  zoom: number;
  overheat: boolean;
  jam: boolean;
  firing: boolean;
}
export interface CarSnap {
  alive: boolean;
  grounded: boolean;
  boosting: boolean;
  handbrake: boolean;
  burnOn: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  steer: number;
  throttle: number;
  leanP: number;
  leanR: number;
  land: number;
  hp: number;
  boostFuel: number;
  burnT: number;
  guns: [GunSnap, GunSnap];
}
export interface Snapshot {
  /** Hub time it was taken, in ms. */
  time: number;
  state: RoundState;
  /** The round's clock: the countdown, or the time to the next round. */
  timer: number;
  cars: CarSnap[];
}

const PI = Math.PI;
const wrap = (a: number): number => {
  a = (a + PI) % (2 * PI);
  return (a < 0 ? a + 2 * PI : a) - PI;
};

/** A value in [-1, 1] as one signed byte. Unlike q8, 0 and ±1 come back exactly: an idle stick reads 0. */
const putUnit = (w: Writer, v: number): Writer => w.i8(Math.round(Math.max(-1, Math.min(1, v || 0)) * 127));
const getUnit = (r: Reader): number => Math.max(-1, r.i8() / 127);

function writeGun(w: Writer, g: GunSnap): void {
  w.q16(wrap(g.yaw), -PI, PI)
    .q16(g.pitch, -0.6, 1.2)
    .q8(g.loft, 0, 0.8)
    .q8(g.heat, 0, 1)
    .q8(g.recoil, 0, 1)
    .q8(g.zoom, 0, 1);
  w.u8((g.overheat ? 1 : 0) | (g.jam ? 2 : 0) | (g.firing ? 4 : 0));
}
function readGun(r: Reader): GunSnap {
  const yaw = r.q16(-PI, PI),
    pitch = r.q16(-0.6, 1.2),
    loft = r.q8(0, 0.8),
    heat = r.q8(0, 1),
    recoil = r.q8(0, 1),
    zoom = r.q8(0, 1);
  const f = r.u8();
  return { yaw, pitch, loft, heat, recoil, zoom, overheat: !!(f & 1), jam: !!(f & 2), firing: !!(f & 4) };
}

export function writeSnapshot(w: Writer, s: Snapshot): Writer {
  w.u8(SNAP_VERSION)
    .f64(s.time)
    .u8(Math.max(0, STATES.indexOf(s.state)))
    .q16(s.timer, 0, 60)
    .u8(s.cars.length);
  for (const c of s.cars) {
    w.u8(
      (c.alive ? 1 : 0) |
        (c.grounded ? 2 : 0) |
        (c.boosting ? 4 : 0) |
        (c.handbrake ? 8 : 0) |
        (c.burnOn ? 16 : 0),
    );
    w.q16(c.x, -400, 400).q16(c.y, -30, 90).q16(c.z, -400, 400).q16(wrap(c.yaw), -PI, PI);
    w.q16(c.vx, -90, 90).q16(c.vy, -60, 60).q16(c.vz, -90, 90).q16(c.yawRate, -20, 20);
    putUnit(putUnit(putUnit(putUnit(w, c.steer), c.throttle), c.leanP), c.leanR).q8(c.land, 0, 2);
    w.q8(c.hp, 0, 100).q8(c.boostFuel, 0, 1).q8(c.burnT, 0, 15);
    writeGun(w, c.guns[0]);
    writeGun(w, c.guns[1]);
  }
  return w;
}

/** A snapshot, or null when it isn't one this version reads. */
export function readSnapshot(r: Reader, maxCars = 8): Snapshot | null {
  if (r.u8() !== SNAP_VERSION) return null;
  const time = r.f64(),
    state = STATES[r.u8()] ?? 'menu',
    timer = r.q16(0, 60),
    n = r.u8();
  if (n > maxCars) return null;
  const cars: CarSnap[] = [];
  for (let i = 0; i < n; i++) {
    const f = r.u8();
    const x = r.q16(-400, 400),
      y = r.q16(-30, 90),
      z = r.q16(-400, 400),
      yaw = r.q16(-PI, PI);
    const vx = r.q16(-90, 90),
      vy = r.q16(-60, 60),
      vz = r.q16(-90, 90),
      yawRate = r.q16(-20, 20);
    const steer = getUnit(r),
      throttle = getUnit(r),
      leanP = getUnit(r),
      leanR = getUnit(r),
      land = r.q8(0, 2);
    const hp = r.q8(0, 100),
      boostFuel = r.q8(0, 1),
      burnT = r.q8(0, 15);
    const guns: [GunSnap, GunSnap] = [readGun(r), readGun(r)];
    cars.push({
      alive: !!(f & 1),
      grounded: !!(f & 2),
      boosting: !!(f & 4),
      handbrake: !!(f & 8),
      burnOn: !!(f & 16),
      x,
      y,
      z,
      yaw,
      vx,
      vy,
      vz,
      yawRate,
      steer,
      throttle,
      leanP,
      leanR,
      land,
      hp,
      boostFuel,
      burnT,
      guns,
    });
  }
  return r.overrun ? null : { time, state, timer, cars };
}

/** One player's controls: what is held right now, and for a gunner where the gun points. */
export interface Controls {
  throttle: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
  fire: boolean;
  zoom: boolean;
  /** A gunner aims on their own screen: the host takes the angles, and where the crosshair lands. */
  aimYaw: number;
  aimPitch: number;
  aimX: number;
  aimY: number;
  aimZ: number;
}
export const NO_CONTROLS: Readonly<Controls> = {
  throttle: 0,
  steer: 0,
  handbrake: false,
  boost: false,
  fire: false,
  zoom: false,
  aimYaw: 0,
  aimPitch: 0,
  aimX: 0,
  aimY: 0,
  aimZ: 0,
};

/** Controls for each of this screen's players, by their index on this screen. */
export function writeControls(w: Writer, list: readonly (readonly [number, Controls])[]): Writer {
  w.u8(list.length);
  for (const [i, c] of list) {
    putUnit(putUnit(w.u8(i), c.throttle), c.steer);
    w.u8((c.handbrake ? 1 : 0) | (c.boost ? 2 : 0) | (c.fire ? 4 : 0) | (c.zoom ? 8 : 0));
    w.q16(wrap(c.aimYaw), -PI, PI)
      .q16(c.aimPitch, -0.6, 1.2)
      .q16(c.aimX, -400, 400)
      .q16(c.aimY, -30, 90)
      .q16(c.aimZ, -400, 400);
  }
  return w;
}

export function readControls(r: Reader, max = 4): [number, Controls][] | null {
  const n = r.u8();
  if (n > max) return null;
  const out: [number, Controls][] = [];
  for (let k = 0; k < n; k++) {
    const i = r.u8(),
      throttle = getUnit(r),
      steer = getUnit(r),
      f = r.u8();
    const aimYaw = r.q16(-PI, PI),
      aimPitch = r.q16(-0.6, 1.2),
      aimX = r.q16(-400, 400),
      aimY = r.q16(-30, 90),
      aimZ = r.q16(-400, 400);
    out.push([
      i,
      {
        throttle,
        steer,
        handbrake: !!(f & 1),
        boost: !!(f & 2),
        fire: !!(f & 4),
        zoom: !!(f & 8),
        aimYaw,
        aimPitch,
        aimX,
        aimY,
        aimZ,
      },
    ]);
  }
  return r.overrun ? null : out;
}
