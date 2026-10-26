import type { Car } from '../car-types.ts';
/**
 * How each shared effect's arguments travel (see effects.ts). write() mirrors the function's own
 * parameters; read() checks everything, because it comes from another screen: a car that isn't here,
 * a list index out of range, or a label that isn't ours, and the effect is skipped. Colours travel
 * as team numbers and are turned back into the team's paint here.
 */
import { TEAMS } from '../core.ts';
import { dentCar } from '../car.ts';
import { G } from '../state.ts';
import {
  crackFromKnock,
  crackGlassAt,
  crackWindshield,
  groundSplat,
  paintBurst,
  paintCss,
  paintHitCar,
  paintImpact,
  wallSplat,
} from '../paint.ts';
import {
  awardFx,
  burnEndFx,
  crashFx,
  feedBurnFx,
  feedRadarFx,
  headshotMarkFx,
  hitMarkFx,
  knockFx,
  noteFx,
  radarHitFx,
  shotFx,
  wreckFx,
  NOTES,
} from '../sharedfx.ts';
import { knockOver } from '../breakables.ts';
import { placeDrop, takeDrop } from '../drops.ts';
import { defineEffect, FX } from './effects.ts';
import type { Reader, Writer } from '/zirbel-net.js';

interface Vec {
  x: number;
  y: number;
  z: number;
}

const NONE = 255;
const ZONES = ['front', 'rear', 'lf', 'rf', 'lr', 'rr'] as const;
// 'explosion' is unused since the mines went; it keeps its place, because the order is the wire format
const CAUSES = ['crash', 'wall', 'explosion', 'gun', 'landing', 'prop', 'fire'] as const;
const DROPS = ['fuel', 'tyre', 'bumper', 'glass'] as const;
const KNOCKS = ['wall', 'land'] as const;
/** Drops on the map at once, counting ones being picked up: the host keeps six. */
const MAX_DROPS = 12;

// ---- writing ----

const wCar = (w: Writer, c: Car | null | undefined): void => void w.u8(c ? c.idx : NONE);
const wWorld = (w: Writer, x: number, y: number, z: number): void =>
  void w.q16(x, -400, 400).q16(y, -30, 90).q16(z, -400, 400);
const wLocal = (w: Writer, v: Vec): void => void w.q16(v.x, -4, 4).q16(v.y, -4, 4).q16(v.z, -4, 4);
const wDir = (w: Writer, v: Vec): void => void w.q8(v.x, -1.5, 1.5).q8(v.y, -1.5, 1.5).q8(v.z, -1.5, 1.5);
/** A paint colour is always a team's: send the team. */
const wPaint = (w: Writer, css: string): void =>
  void w.u8(
    Math.max(
      0,
      TEAMS.findIndex((_, t) => paintCss(t) === css),
    ),
  );
const wPick = (w: Writer, list: readonly string[], v: string | null | undefined): void =>
  void w.u8(v == null ? NONE : Math.max(0, list.indexOf(v)));

// ---- reading: undefined means "skip the effect" ----

/** A car of this round. */
function rCar(r: Reader): Car | undefined {
  return G.cars[r.u8()];
}
/** A car, or null where the effect allows none. */
function rCarOrNone(r: Reader): Car | null | undefined {
  const i = r.u8();
  return i === NONE ? null : G.cars[i];
}
const rWorld = (r: Reader): Vec => ({ x: r.q16(-400, 400), y: r.q16(-30, 90), z: r.q16(-400, 400) });
const rLocal = (r: Reader): Vec => ({ x: r.q16(-4, 4), y: r.q16(-4, 4), z: r.q16(-4, 4) });
const rDir = (r: Reader): Vec => ({ x: r.q8(-1.5, 1.5), y: r.q8(-1.5, 1.5), z: r.q8(-1.5, 1.5) });
function rPaint(r: Reader): string | undefined {
  const t = r.u8();
  return t < TEAMS.length ? paintCss(t) : undefined;
}
function rPick<T extends string>(r: Reader, list: readonly T[], noneOk: false): T | undefined;
function rPick<T extends string>(r: Reader, list: readonly T[], noneOk: true): T | null | undefined;
function rPick<T extends string>(r: Reader, list: readonly T[], noneOk: boolean): T | null | undefined {
  const i = r.u8();
  if (i === NONE) return noneOk ? null : undefined;
  return list[i];
}

// ---- the effects ----

defineEffect(FX.dent, dentCar, {
  write(w, [c, lp, dir, amount]) {
    wCar(w, c);
    wLocal(w, lp);
    wDir(w, dir);
    w.q16(amount, 0, 60);
  },
  read(r) {
    const c = rCar(r),
      lp = rLocal(r),
      dir = rDir(r),
      amount = r.q16(0, 60);
    return c !== undefined ? [c, lp, dir, amount] : null;
  },
});
defineEffect(FX.paintHitCar, paintHitCar, {
  write(w, [c, l, axis, sign, css]) {
    wCar(w, c);
    wLocal(w, l);
    w.u8(axis).i8(sign);
    wPaint(w, css);
  },
  read(r) {
    const c = rCar(r),
      l = rLocal(r),
      axis = r.u8(),
      sign = r.i8() < 0 ? -1 : 1,
      css = rPaint(r);
    return c !== undefined && css !== undefined && axis <= 2 ? [c, l, axis, sign, css] : null;
  },
});
defineEffect(FX.paintImpact, paintImpact, {
  write(w, [p, n, vin, css, strength = 1]) {
    const pp = p,
      v = vin;
    wWorld(w, pp.x, pp.y, pp.z);
    wDir(w, n);
    w.bool(!!v);
    if (v) w.q16(v.x, -150, 150).q16(v.y, -150, 150).q16(v.z, -150, 150);
    wPaint(w, css);
    w.q8(strength, 0, 4);
  },
  read(r) {
    const p = rWorld(r),
      n = rDir(r),
      has = r.bool();
    const vin = has
      ? {
          x: r.q16(-150, 150),
          y: r.q16(-150, 150),
          z: r.q16(-150, 150),
          length() {
            return Math.hypot(this.x, this.y, this.z);
          },
        }
      : null;
    const css = rPaint(r),
      strength = r.q8(0, 4);
    return css !== undefined ? [p, n, vin, css, strength] : null;
  },
});
defineEffect(FX.groundSplat, groundSplat, {
  write(w, [p, size, css, y = 0.03]) {
    const pp = p;
    w.q16(pp.x, -400, 400).q16(pp.z, -400, 400).q8(size, 0, 10);
    wPaint(w, css);
    w.q16(y, -5, 60);
  },
  read(r) {
    const x = r.q16(-400, 400),
      z = r.q16(-400, 400),
      size = r.q8(0, 10),
      css = rPaint(r),
      y = r.q16(-5, 60);
    return css !== undefined ? [{ x, y: 0, z }, size, css, y] : null;
  },
});
defineEffect(FX.wallSplat, wallSplat, {
  write(w, [p, n, size, css]) {
    const pp = p;
    wWorld(w, pp.x, pp.y, pp.z);
    wDir(w, n);
    w.q8(size, 0, 10);
    wPaint(w, css);
  },
  read(r) {
    const p = rWorld(r),
      n = rDir(r),
      size = r.q8(0, 10),
      css = rPaint(r);
    return css !== undefined ? [p, n, size, css] : null;
  },
});
defineEffect(FX.paintBurst, paintBurst, {
  write(w, [x, y, z, css, big = false]) {
    wWorld(w, x, y, z);
    wPaint(w, css);
    w.bool(!!big);
  },
  read(r) {
    const p = rWorld(r),
      css = rPaint(r),
      big = r.bool();
    return css !== undefined ? [p.x, p.y, p.z, css, big] : null;
  },
});
defineEffect(FX.crackFromKnock, crackFromKnock, {
  write(w, [c, zone, cause, dv]) {
    wCar(w, c);
    wPick(w, ZONES, zone);
    wPick(w, CAUSES, cause);
    w.q16(dv, 0, 80);
  },
  read(r) {
    const c = rCar(r),
      zone = rPick(r, ZONES, true),
      cause = rPick(r, CAUSES, false),
      dv = r.q16(0, 80);
    return c !== undefined && zone !== undefined && cause !== undefined && cause !== 'explosion'
      ? [c, zone, cause, dv]
      : null;
  },
});
defineEffect(FX.crackWindshield, crackWindshield, {
  write(w, [c, u, v, strength = 1]) {
    wCar(w, c);
    w.q8(u, 0, 1).q8(v, 0, 1).q8(strength, 0, 4);
  },
  read(r) {
    const c = rCar(r),
      u = r.q8(0, 1),
      v = r.q8(0, 1),
      s = r.q8(0, 4);
    return c !== undefined ? [c, u, v, s] : null;
  },
});
defineEffect(FX.crackGlassAt, crackGlassAt, {
  write(w, [c, l, strength]) {
    wCar(w, c);
    wLocal(w, l);
    w.q8(strength, 0, 4);
  },
  read(r) {
    const c = rCar(r),
      l = rLocal(r),
      s = r.q8(0, 4);
    return c !== undefined ? [c, l, s] : null;
  },
});
defineEffect(FX.crash, crashFx, {
  write(w, [x, y, z, strength, a, b]) {
    wWorld(w, x, y, z);
    w.q16(strength, 0, 80);
    wCar(w, a);
    wCar(w, b);
  },
  read(r) {
    const p = rWorld(r),
      s = r.q16(0, 80),
      a = rCarOrNone(r),
      b = rCarOrNone(r);
    return a !== undefined && b !== undefined ? [p.x, p.y, p.z, s, a, b] : null;
  },
});
defineEffect(FX.knock, knockFx, {
  write(w, [kind, c, x, y, z, strength]) {
    wPick(w, KNOCKS, kind);
    wCar(w, c);
    wWorld(w, x, y, z);
    w.q16(strength, 0, 80);
  },
  read(r) {
    const kind = rPick(r, KNOCKS, false),
      c = rCar(r),
      p = rWorld(r),
      s = r.q16(0, 80);
    return kind !== undefined && c !== undefined ? [kind, c, p.x, p.y, p.z, s] : null;
  },
});
defineEffect(FX.wreck, wreckFx, {
  write(w, [c, killer, cause, x, y, z]) {
    wCar(w, c);
    wCar(w, killer);
    wPick(w, CAUSES, cause);
    wWorld(w, x, y, z);
  },
  read(r) {
    const c = rCar(r),
      killer = rCarOrNone(r),
      cause = rPick(r, CAUSES, false),
      p = rWorld(r);
    return c !== undefined && killer !== undefined && cause !== undefined && cause !== 'explosion'
      ? [c, killer, cause, p.x, p.y, p.z]
      : null;
  },
});
defineEffect(FX.shot, shotFx, {
  write(w, [c, seat, mx, my, mz, vx, vy, vz]) {
    wCar(w, c);
    w.u8(seat);
    wWorld(w, mx, my, mz);
    w.q16(vx, -150, 150).q16(vy, -150, 150).q16(vz, -150, 150);
  },
  read(r) {
    const c = rCar(r),
      seat = r.u8(),
      m = rWorld(r),
      vx = r.q16(-150, 150),
      vy = r.q16(-150, 150),
      vz = r.q16(-150, 150);
    return c !== undefined && (seat === 1 || seat === 2) ? [c, seat, m.x, m.y, m.z, vx, vy, vz] : null;
  },
});
defineEffect(FX.hitMark, hitMarkFx, {
  write(w, [c, seat]) {
    wCar(w, c);
    w.u8(seat);
  },
  read(r) {
    const c = rCar(r),
      seat = r.u8();
    return c !== undefined && seat < 4 ? [c, seat] : null;
  },
});
defineEffect(FX.award, awardFx, {
  write(w, [c, pts, label]) {
    wCar(w, c);
    w.q16(pts, 0, 5000).str(String(label).slice(0, 24));
  },
  read(r) {
    const c = rCar(r),
      pts = r.q16(0, 5000),
      label = r.str().slice(0, 24);
    return c !== undefined ? [c, pts, label] : null;
  },
});
defineEffect(FX.feedRadar, feedRadarFx, {
  write(w, [by, c, pts]) {
    wCar(w, by);
    wCar(w, c);
    w.q16(pts, 0, 5000);
  },
  read(r) {
    const by = rCar(r),
      c = rCar(r),
      pts = r.q16(0, 5000);
    return by !== undefined && c !== undefined ? [by, c, pts] : null;
  },
});
defineEffect(FX.feedBurn, feedBurnFx, {
  write(w, [c, seconds, pts]) {
    wCar(w, c);
    w.q8(seconds, 0, 15).q16(pts, 0, 5000);
  },
  read(r) {
    const c = rCar(r),
      s = r.q8(0, 15),
      pts = r.q16(0, 5000);
    return c !== undefined ? [c, s, pts] : null;
  },
});
defineEffect(FX.note, noteFx, {
  write(w, [c, note]) {
    wCar(w, c);
    w.u8(note);
  },
  read(r) {
    const c = rCar(r),
      note = r.u8();
    return c !== undefined && note < NOTES.length ? [c, note] : null;
  },
});
defineEffect(FX.headshotMark, headshotMarkFx, {
  write(w, [by]) {
    wCar(w, by);
  },
  read(r) {
    const by = rCar(r);
    return by !== undefined ? [by] : null;
  },
});
defineEffect(FX.burnEnd, burnEndFx, {
  write(w, [c, kept]) {
    wCar(w, c);
    w.u8(kept ? 1 : 0);
  },
  read(r) {
    const c = rCar(r),
      kept = r.u8() === 1;
    return c !== undefined ? [c, kept] : null;
  },
});
defineEffect(FX.radarHit, radarHitFx, {
  write(w, [c]) {
    wCar(w, c);
  },
  read(r) {
    const c = rCar(r);
    return c !== undefined ? [c] : null;
  },
});
defineEffect(FX.breakProp, knockOver, {
  write(w, [i, dx, dz, vn, c]) {
    w.u16(i).q8(dx, -1, 1).q8(dz, -1, 1).q8(vn, 0, 60);
    wCar(w, c);
  },
  read(r) {
    const i = r.u16(),
      dx = r.q8(-1, 1),
      dz = r.q8(-1, 1),
      vn = r.q8(0, 60),
      c = rCarOrNone(r);
    return c !== undefined ? [i, dx, dz, vn, c] : null;
  },
});
defineEffect(FX.placeDrop, placeDrop, {
  write(w, [id, type, x, z, t]) {
    w.u32(id);
    wPick(w, DROPS, type);
    w.q16(x, -400, 400).q16(z, -400, 400).q8(t, 0, 6);
  },
  read(r) {
    const id = r.u32(),
      type = rPick(r, DROPS, false),
      x = r.q16(-400, 400),
      z = r.q16(-400, 400),
      t = r.q8(0, 6);
    // the host keeps a handful on the map: a flood isn't one
    return type !== undefined &&
      G.drops.length < MAX_DROPS &&
      !G.drops.some((d: { id: number }) => d.id === id)
      ? [id, type, x, z, t]
      : null;
  },
});
defineEffect(FX.takeDrop, takeDrop, {
  write(w, [id]) {
    w.u32(id);
  },
  read(r) {
    return [r.u32()];
  },
});
