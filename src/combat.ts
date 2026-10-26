import { requireValue } from './required-fields.ts';
import { gunAt, gunKey } from './gameplay/guns.ts';
import { jamGun } from './gun-state.ts';
import type { Projectile } from './gameplay/model.ts';
import type { Occupant } from './car-types.ts';
import type { Car } from './car.ts';
import { D } from './data.ts';
import * as THREE from 'three';
import { aimDir, boxNormal, carToWorld, intersectBox, toLocal, zoneOf } from './gameplay/geometry.ts';
import { CARDIM, GUN, TURRETS, _v3, clamp, damp, rand } from './core.ts';
import { BOUNDS, OBSTACLES, arenaNormal, arenaSDF } from './world.ts';
import { G } from './state.ts';
import { hitCar } from './physics.ts';
import {} from './audio.ts';
import { _bd, groundSplat, paintCss, paintHitCar, paintImpact, wallSplat } from './paint.ts';
import { damageRadar, rayRadar } from './radar.ts';
import { RADAR } from './radar-model.ts';
import { POINTS, award } from './score.ts';
import { hitMarkFx, shotFx } from './sharedfx.ts';
import { isReplica } from './net/role.ts';
import { recordCompetitionShot, recordCompetitionHit } from './competition.ts';

// =====================================================================
//  Ray queries (paintballs + aiming)
// =====================================================================
// a ball round a car's box (the radar on its roof is well inside), centred CAR_MID up from its wheels
const CAR_MID = (CARDIM.bottom + CARDIM.top) / 2,
  CAR_BALL = Math.hypot(CARDIM.hw, CARDIM.hl, (CARDIM.top - CARDIM.bottom) / 2) + 0.05;

// Nearest hit along o + d*t, t in [0, maxT]. d must be normalised.
// Returns { t, kind: 'ground' | 'wall' | 'car', car, n (world normal), axis/sign (face of the box hit), decal }.
interface RayHit {
  t: number;
  kind: 'car' | 'ground' | 'wall' | null;
  car: Car | null;
  n: THREE.Vector3;
  axis: number;
  sign: number;
  decal: boolean;
  radar: boolean;
}
const RAY_HIT: RayHit = {
  t: 0,
  kind: null,
  car: null,
  n: new THREE.Vector3(),
  axis: 0,
  sign: 1,
  decal: false,
  radar: false,
};
export function raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number, ignoreCar: Car | null) {
  let kind: RayHit['kind'] = null,
    car: Car | null = null;
  let best = maxT,
    decal = false,
    axis = 0,
    sign = 1,
    radar = false;
  const n = RAY_HIT.n;
  // ground plane
  if (d.y < -1e-5) {
    const t = -o.y / d.y;
    if (t > 0 && t < best) {
      best = t;
      kind = 'ground';
      n.set(0, 1, 0);
      decal = true;
    }
  }
  // arena edge (march only if the end point is outside)
  const hz = Math.hypot(d.x, d.z);
  if (hz > 1e-4 && arenaSDF(o.x + d.x * best, o.z + d.z * best) > 0) {
    let t = 0;
    for (let i = 0; i < 40 && t < best; i++) {
      const s = arenaSDF(o.x + d.x * t, o.z + d.z * t);
      if (s > -0.02) {
        if (o.y + d.y * t < BOUNDS.wallH) {
          best = t;
          kind = 'wall';
          arenaNormal(o.x + d.x * t, o.z + d.z * t, n).negate();
          decal = false;
        }
        break;
      }
      t += Math.max(-s / hz, 0.02);
    }
  }
  // obstacles (skip the ones nowhere near the ray)
  const ex = o.x + d.x * best,
    ez = o.z + d.z * best;
  const rx0 = Math.min(o.x, ex),
    rx1 = Math.max(o.x, ex),
    rz0 = Math.min(o.z, ez),
    rz1 = Math.max(o.z, ez);
  for (const ob of OBSTACLES) {
    if (ob.down) continue;
    const br = ob.br || (ob.br = ob.kind === 'circle' ? ob.r : Math.hypot(ob.hw, ob.hl));
    if (ob.x + br < rx0 || ob.x - br > rx1 || ob.z + br < rz0 || ob.z - br > rz1) continue;
    if (ob.kind === 'circle') {
      const fx = o.x - ob.x,
        fz = o.z - ob.z;
      const a = d.x * d.x + d.z * d.z;
      if (a < 1e-8) continue;
      const b = fx * d.x + fz * d.z,
        c = fx * fx + fz * fz - ob.r * ob.r;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / a;
      if (t > 0 && t < best) {
        const y = o.y + d.y * t;
        if (y >= 0 && y <= ob.h) {
          best = t;
          kind = 'wall';
          n.set(fx + d.x * t, 0, fz + d.z * t).normalize();
          decal = ob.r >= 2;
        }
      }
    } else {
      const hit = intersectBox(o, d, ob.x, 0, ob.z, ob.yaw, ob.hw, ob.h, ob.hl, best);
      if (hit !== null) {
        best = hit.t;
        kind = 'wall';
        boxNormal(ob.yaw, hit.axis, hit.sign, n);
        decal = true;
      }
    }
  }
  // cars
  for (const c of G.cars) {
    if (c === ignoreCar) continue;
    // bounding-sphere reject
    const cx = c.pos.x - o.x,
      cy = c.pos.y + CAR_MID - o.y,
      cz = c.pos.z - o.z;
    const tc = cx * d.x + cy * d.y + cz * d.z;
    if (tc < -CAR_BALL || tc > best + CAR_BALL) continue;
    const dd = cx * cx + cy * cy + cz * cz - tc * tc;
    if (dd > CAR_BALL * CAR_BALL) continue;
    const hit = intersectBox(
      o,
      d,
      c.pos.x,
      c.pos.y + CARDIM.bottom,
      c.pos.z,
      c.yaw,
      CARDIM.hw,
      CARDIM.top - CARDIM.bottom,
      CARDIM.hl,
      best,
    );
    if (hit !== null) {
      best = hit.t;
      kind = 'car';
      car = c;
      axis = hit.axis;
      sign = hit.sign;
      boxNormal(c.yaw, axis, sign, n);
      decal = false;
      radar = false;
    }
    // the radar sticks up above the roof
    const tr = rayRadar(o, d, c, best);
    if (tr !== null) {
      best = tr;
      kind = 'car';
      car = c;
      axis = 1;
      sign = 1;
      n.set(0, 1, 0);
      decal = false;
      radar = true;
    }
  }
  if (!kind) return null;
  Object.assign(RAY_HIT, { t: best, kind, car, axis, sign, decal, radar });
  return RAY_HIT;
}

// =====================================================================
//  Paintball markers
// =====================================================================
export const _dir = new THREE.Vector3(),
  _muz = new THREE.Vector3();

export function gunMuzzle(car: Car, s: number, out: THREE.Vector3) {
  const g = gunAt(car, s),
    m = TURRETS[gunKey(s)].pos;
  carToWorld(car, m[0], m[1] + 0.17, m[2], out);
  return out.addScaledVector(aimDir(g.yaw, g.pitch + (g.loft || 0), _dir), 0.66);
}

// Elevation needed (on top of the straight line) to lob a ball from `from` onto `to`.
function loftAngle(from: THREE.Vector3, to: THREE.Vector3) {
  const dx = to.x - from.x,
    dz = to.z - from.z,
    dy = to.y - from.y;
  const d = Math.hypot(dx, dz);
  if (d < 1) return 0;
  const v = GUN.speed,
    g = GUN.gravity,
    v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  const want = disc < 0 ? Math.PI / 4 : Math.atan((v2 - Math.sqrt(disc)) / (g * d));
  return clamp(want - Math.atan2(dy, d), 0, 0.6);
}

export function updateGun(car: Car, s: number, dt: number) {
  const g = gunAt(car, s);
  g.cd = Math.max(g.cd - dt, -0.02);
  g.recoil = Math.max(0, g.recoil - dt * 9);
  // the barrel only really cools when you let go of the trigger
  g.heat = Math.max(0, g.heat - GUN.cool * (g.firing && !g.overheat && !g.jam ? GUN.coolFiring : 1) * dt);
  if (g.overheat && g.heat < GUN.recover) g.overheat = false;
  const muzzle = gunMuzzle(car, s, _muz);
  g.loft = damp(g.loft || 0, loftAngle(muzzle, g.aimPoint), 12, dt);
  if (!g.firing || !car.alive || !car.occ[s] || G.state !== 'playing' || g.cd > 0 || g.overheat || g.jam)
    return;
  g.cd += 1 / GUN.rate;
  // straight at whatever is under the crosshair, then lofted so the arc comes down on it
  const dir = _v3.copy(g.aimPoint).sub(muzzle);
  if (dir.lengthSq() < 4 || dir.dot(aimDir(g.yaw, g.pitch, _dir)) < 0) dir.copy(_dir);
  dir.normalize();
  const flat = Math.hypot(dir.x, dir.z) || 1,
    up = Math.atan2(dir.y, flat) + loftAngle(muzzle, g.aimPoint);
  const cosU = Math.cos(up);
  dir.set((dir.x / flat) * cosU, Math.sin(up), (dir.z / flat) * cosU);
  const spread = GUN.spread * (g.zoom > 0.5 ? GUN.zoomSpread : 1) * (1 + g.heat * GUN.hotSpray); // a hot barrel sprays
  dir.x += rand(-spread, spread);
  dir.y += rand(-spread, spread) * 0.7;
  dir.z += rand(-spread, spread);
  dir.normalize();
  const ball = spawnBall(car, muzzle, dir, car.occ[s]);
  recordCompetitionShot(car, s, ball);
  g.heat += GUN.heat;
  if (g.heat >= 1) {
    g.heat = 1;
    g.overheat = true;
    if (Math.random() < GUN.jamOnOverheat) jamGun(car, s);
  } else if (g.heat > GUN.hot && Math.random() < GUN.jamWhenHot) jamGun(car, s);
  g.recoil = 1;
  // a puff of air from the muzzle instead of a flash, and the ball for the other screens to watch
  shotFx(car, s, ball.p.x, ball.p.y, ball.p.z, ball.v.x, ball.v.y, ball.v.z);
}

function spawnBall(
  car: Car,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  shooter: Occupant | null,
): Projectile<Car> {
  // bots hit softer than people, scaled by bot skill
  const dmg =
    GUN.dmg * (shooter && shooter.kind === 'bot' ? requireValue(D.bots.levels[G.cfg.botSkill]).dmg : 1);
  const css = paintCss(car.team);
  const ball = {
    p: from.clone(),
    v: dir.clone().multiplyScalar(GUN.speed * rand(0.97, 1.03)),
    dmg,
    car,
    team: car.team,
    shooter,
    age: 0,
    css,
    color3: new THREE.Color(css),
  };
  G.bullets.push(ball);
  return ball;
}

const _hp = new THREE.Vector3();
export function updateBullets(dt: number) {
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const b = requireValue(G.bullets[i]);
    b.age += dt;
    b.v.y -= GUN.gravity * dt;
    const sp = b.v.length(),
      step = sp * dt;
    _bd.copy(b.v).divideScalar(sp);
    const hit = raycast(b.p, _bd, step, b.car);
    if (hit) {
      _hp.copy(b.p).addScaledVector(_bd, hit.t);
      if (!isReplica()) ballHit(b, _hp, hit); // on the other screens a ball only flies: the host's game decides what it hit
      G.bullets.splice(i, 1);
      continue;
    }
    b.p.addScaledVector(_bd, step);
    if (b.age > GUN.life) G.bullets.splice(i, 1);
  }
}

// SPLAT.
function ballHit(b: Projectile<Car>, p: THREE.Vector3, hit: RayHit) {
  if (hit.kind === 'car' && hit.car?.alive && hit.car.team !== b.car.team) recordCompetitionHit(b);
  paintImpact(p, hit.n, b.v, b.css);
  if (hit.kind === 'car' && hit.car && hit.radar) {
    // shot the radar: it takes the hit, the car doesn't
    if (!hit.car.radar.destroyed && b.car && b.car.team !== hit.car.team && G.state === 'playing')
      award(b.car, POINTS.radarHit, 'HEADSHOT', 'hs');
    damageRadar(hit.car, b.dmg * GUN.radar.hit, b.car);
    if (b.shooter && b.shooter.kind === 'human') hitMarkFx(b.car, b.shooter.h.seat);
  } else if (hit.kind === 'car' && hit.car) {
    const c = hit.car,
      l = toLocal(c, p.x, p.y, p.z);
    paintHitCar(c, l, hit.axis, hit.sign, b.css);
    if (hit.axis === 1 && Math.hypot(l.x, l.z - RADAR.z) < GUN.radar.splashRadius)
      damageRadar(c, b.dmg * GUN.radar.splash, b.car); // splash on the roof next to it
    const dealt = hitCar(c, b.dmg, b.car, zoneOf(l), 'gun', l);
    if (dealt > 0 && b.shooter && b.shooter.kind === 'human') hitMarkFx(b.car, b.shooter.h.seat);
  } else if (hit.kind === 'ground') {
    groundSplat(p, rand(0.9, 1.4), b.css);
  } else if (hit.decal) {
    wallSplat(p, hit.n, rand(0.9, 1.3), b.css);
  }
}
