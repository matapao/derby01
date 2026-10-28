import { requireValue } from './required-fields.ts';
import type { Car } from './car.ts';
import { applyChassisDamage } from './gameplay/damage.ts';
import {
  BODY_PANELS,
  collisionBodyDamage,
  wreckBodyDamage,
  type BodyInventory,
} from './gameplay/body-damage.ts';
import type { DamageCause } from './gameplay/model.ts';
import * as THREE from 'three';
import { toLocal, zoneOf, type DamageZone, type Vector } from './gameplay/geometry.ts';
import { CARDIM, MAX_HP, _v1, clamp, damp, lerp, rand, setPaintDamage } from './core.ts';
import { OBSTACLES, arenaNormal, arenaSDF, groundHeight, surfaceGrip } from './world.ts';
import {
  BUMPER_NAMES,
  ZONE_BUMPER,
  bumperLeft,
  dentCar,
  refreshOccupantVisuals,
  settleBumper,
  tearOffBumper,
} from './car.ts';
import { G } from './state.ts';
import { hitBreakable } from './breakables.ts';
import { detachKit, kitHit } from './kits.ts';
import { CAR_SPECS } from './kit-data.ts';
import { addDebris } from './fx.ts';
import { crackFromKnock } from './paint.ts';
import { damageRadar } from './radar.ts';
import { POINTS, award, burnCrash, scoreDamage } from './score.ts';
import { breakAxle, loseWheel, systemsHit, wearTire } from './mechanic.ts';
import { checkRoundEnd } from './round.ts';
import { crashFx, knockFx, wreckFx } from './sharedfx.ts';
import { D } from './data.ts';

// =====================================================================
//  Car physics (arcade, 2.5D: rigid body in X/Z + simple vertical motion)
//  yaw: forward = (sin yaw, cos yaw); left = (cos yaw, -sin yaw)
//  Every number that tunes it is in data/physics.json (and data/damage.json for the hurt).
// =====================================================================

function stepCar(car: Car, dt: number) {
  const c = car.ctrl,
    E = D.physics.engine,
    N = D.physics.nitro,
    R = D.physics.drag,
    GR = D.physics.grip,
    ST = D.physics.steering;
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  let vF = car.vel.x * sy + car.vel.z * cy;
  let vL = car.vel.x * cy - car.vel.z * sy;
  const alive = car.alive;
  const M = car.mods; // engine, fuel, tyres and axles all feed into these
  const K = car.spec || CAR_SPECS['stock']; // and how this car drives (kits.ts)
  const throttle = alive ? c.throttle : 0;
  const steerIn = alive ? clamp(c.steer * M.steer + M.bias + M.wobble, -1, 1) : 0;
  const handbrake = alive ? c.handbrake : true;
  car.boosting = false;

  if (car.grounded) {
    let a = 0;
    if (throttle > 0) {
      const boosting = c.boost && car.boostFuel > 0.02 && M.power > 0;
      car.boosting = boosting;
      const vmax = (boosting ? N.top + N.topPerKick * (K.nitro - 1) : E.top) * M.vmax * K.vmax;
      a +=
        throttle *
        (boosting ? N.accel * K.nitro : E.accel * K.accel) *
        M.power *
        clamp(1 - Math.max(vF, 0) / vmax, 0, 1);
      if (vF < -0.5) a += throttle * E.brakeReversing; // brakes work without an engine
    } else if (throttle < 0) {
      if (vF > 0.5) a += throttle * E.brake;
      else a += throttle * E.reverse * M.power * clamp(1 + Math.min(vF, 0) / E.reverseTop, 0, 1);
    }
    const sg0 = surfaceGrip(car.pos.x, car.pos.z),
      sg = sg0 < 1 ? (sg0 / 0.78) * K.grass : 1; // grass: less grip, more drag (the rally car minds it least)
    const res =
      R.rolling +
      R.air * vF * vF +
      (handbrake ? R.handbrake : 0) +
      (throttle === 0 ? R.coast : 0) +
      (alive ? 0 : R.wreck) +
      (1 - sg) * R.grass;
    vF += a * dt;
    const dv = res * dt;
    vF = Math.abs(vF) <= dv ? 0 : vF - Math.sign(vF) * dv;

    // just after a big knock the tyres skate: the car slides and spins away
    const stun = clamp(car.stun / D.damage.kick.stunMax, 0, 1);
    // full throttle with the wheel turned at speed lets the tail go (some cars much more than others)
    const power =
      !handbrake && throttle > 0.6 && Math.abs(steerIn) > 0.55 && Math.abs(vF) > GR.slideAbove ? K.slide : 0;
    const grip =
      (handbrake ? GR.handbrake * (1.1 - K.slide * 0.4) : alive ? GR.tyres * K.grip : GR.wreck) *
      M.grip *
      sg *
      (1 - GR.stunned * stun) *
      (1 - GR.sliding * power) *
      dt;
    vL = Math.abs(vL) <= grip ? 0 : vL - Math.sign(vL) * grip;

    const speed = Math.abs(vF);
    const maxSteer = lerp(ST.lockSlow, ST.lockFast, clamp(speed / ST.fastAt, 0, 1)) * K.steer;
    car.steer = damp(car.steer, steerIn * maxSteer, ST.response, dt);
    let targetW = (-vF * Math.tan(car.steer)) / CARDIM.wheelbase;
    const wCap = ((handbrake ? ST.spinHandbrake : ST.spin) * (1 + K.slide * 0.3)) / Math.max(5, speed);
    targetW = clamp(targetW * (handbrake ? ST.handbrakeTurn : 1), -wCap, wCap);
    const yawAcc =
      (((handbrake ? ST.yawHandbrake : ST.yaw) * K.steer) / (1 + Math.abs(vL) * 0.25 * (1 - K.slide * 0.6))) *
      (1 - 0.75 * stun) *
      dt; // a drift car keeps more say over its angle
    car.yawRate += clamp(targetW - car.yawRate, -yawAcc, yawAcc);
  } else {
    car.yawRate *= Math.exp(-0.4 * dt);
    car.steer = damp(car.steer, steerIn * 0.4, ST.response, dt);
  }
  if (car.boosting) car.boostFuel = Math.max(0, car.boostFuel - (N.burn / K.nitro) * dt);
  else car.boostFuel = Math.min(1, car.boostFuel + N.refill * dt);

  // body lean from accelerations (purely visual)
  const aF = (vF - car.prevVF) / dt;
  car.prevVF = vF;
  const aL = vF * car.yawRate;
  const tp = car.grounded ? clamp(-aF * 0.0035, -0.07, 0.09) : 0;
  const tr = car.grounded ? clamp(aL * 0.0055, -0.08, 0.08) : 0;
  car.lean.vp += (140 * (tp - car.lean.p) - 16 * car.lean.vp) * dt;
  car.lean.vr += (140 * (tr - car.lean.r) - 16 * car.lean.vr) * dt;
  car.lean.p += car.lean.vp * dt;
  car.lean.r += car.lean.vr * dt;
  car.land = Math.max(0, car.land - dt * 3);
  car.stun = Math.max(0, car.stun - dt);
  car.lean.p = clamp(car.lean.p, -0.5, 0.5);
  car.lean.r = clamp(car.lean.r, -0.55, 0.55);

  car.vel.x = vF * sy + vL * cy;
  car.vel.z = vF * cy - vL * sy;
  car.yaw += car.yawRate * dt;
  const px = car.pos.x,
    pz = car.pos.z;
  car.pos.x += car.vel.x * dt;
  car.pos.z += car.vel.z * dt;

  // vertical: on the ground, up a ramp and off its lip, or thrown up by a hard knock, and landing again
  let gh = groundHeight(car.pos.x, car.pos.z);
  if (car.grounded && gh > car.pos.y + 0.6) {
    // the side or the back of a ramp: a wall, not a step up
    car.pos.x = px;
    car.pos.z = pz;
    car.vel.x *= -0.2;
    car.vel.z *= -0.2;
    gh = groundHeight(px, pz);
  }
  if (car.grounded) {
    if (gh >= car.pos.y - 0.06) {
      car.vel.y = Math.min((gh - car.pos.y) / dt, 14);
      car.pos.y = gh;
    } else {
      car.grounded = false;
    }
  }
  if (!car.grounded) {
    car.vel.y -= D.physics.gravity * dt;
    car.pos.y += car.vel.y * dt;
    if (car.pos.y <= gh) {
      const impact = -car.vel.y;
      car.pos.y = gh;
      car.vel.y = 0;
      car.grounded = true;
      car.land = clamp(impact / 10, 0, 1);
      car.lean.vp += impact * 0.05;
      if (impact > D.damage.landing.knock) onCarLanded(car, impact);
    }
  }
}

// ---------------------------------------------------------------------
//  Collisions
// ---------------------------------------------------------------------
function pointVel(car: Car, px: number, pz: number) {
  const rx = px - car.pos.x,
    rz = pz - car.pos.z;
  return { x: car.vel.x + car.yawRate * rz, z: car.vel.z - car.yawRate * rx };
}
function applyImpulse(car: Car, px: number, pz: number, ix: number, iz: number) {
  const cushion = 0.58;
  car.vel.x += (ix * cushion) / car.mass;
  car.vel.z += (iz * cushion) / car.mass;
  const rx = px - car.pos.x,
    rz = pz - car.pos.z;
  car.yawRate += ((rz * ix - rx * iz) * 0.35) / car.inertia;
}

// Separating-axis test for two oriented boxes in X/Z. Normal points from A to B.
function satBoxes(
  ax: number,
  az: number,
  ayaw: number,
  ahl: number,
  ahw: number,
  bx: number,
  bz: number,
  byaw: number,
  bhl: number,
  bhw: number,
) {
  const as = Math.sin(ayaw),
    ac = Math.cos(ayaw),
    bs = Math.sin(byaw),
    bc = Math.cos(byaw);
  const axes: [number, number, number][] = [
    [as, ac, 0],
    [ac, -as, 0],
    [bs, bc, 1],
    [bc, -bs, 1],
  ];
  const dx = bx - ax,
    dz = bz - az;
  let best = Infinity,
    nx = 0,
    nz = 0,
    owner = 0;
  for (const [x, z, own] of axes) {
    const ra = ahl * Math.abs(as * x + ac * z) + ahw * Math.abs(ac * x - as * z);
    const rb = bhl * Math.abs(bs * x + bc * z) + bhw * Math.abs(bc * x - bs * z);
    const d = dx * x + dz * z;
    const o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) {
      best = o;
      const sg = d < 0 ? -1 : 1;
      nx = x * sg;
      nz = z * sg;
      owner = own;
    }
  }
  // contact point = the deepest corner of the other box
  let px = 0,
    pz = 0,
    ext = owner === 0 ? Infinity : -Infinity;
  const cx = owner === 0 ? bx : ax,
    cz = owner === 0 ? bz : az;
  const s = owner === 0 ? bs : as,
    c = owner === 0 ? bc : ac,
    hl = owner === 0 ? bhl : ahl,
    hw = owner === 0 ? bhw : ahw;
  for (const fl of [-1, 1])
    for (const fw of [-1, 1]) {
      const x = cx + s * hl * fl + c * hw * fw,
        z = cz + c * hl * fl - s * hw * fw;
      const p = x * nx + z * nz;
      if (owner === 0 ? p < ext : p > ext) {
        ext = p;
        px = x;
        pz = z;
      }
    }
  return { depth: best, nx, nz, px, pz };
}

function resolveContact(
  a: Car,
  b: Car | null,
  hit: NonNullable<ReturnType<typeof satBoxes>>,
  e: number,
  mu: number,
) {
  // b may be null (static world). Normal points from a to b.
  const { nx, nz, px, pz } = hit;
  const va = pointVel(a, px, pz);
  const vb = b ? pointVel(b, px, pz) : { x: 0, z: 0 };
  const rvx = vb.x - va.x,
    rvz = vb.z - va.z;
  const vn = rvx * nx + rvz * nz;
  const ra = { x: px - a.pos.x, z: pz - a.pos.z };
  const raN = ra.z * nx - ra.x * nz;
  let k = 1 / a.mass + (raN * raN) / a.inertia;
  let rbN = 0;
  if (b) {
    rbN = (pz - b.pos.z) * nx - (px - b.pos.x) * nz;
    k += 1 / b.mass + (rbN * rbN) / b.inertia;
  }
  let j = 0;
  if (vn < 0) {
    j = (-(1 + e) * vn) / k;
    applyImpulse(a, px, pz, -j * nx, -j * nz);
    if (b) applyImpulse(b, px, pz, j * nx, j * nz);
    // friction
    const tx = rvx - vn * nx,
      tz = rvz - vn * nz;
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-4) {
      const ux = tx / tl,
        uz = tz / tl;
      const raT = ra.z * ux - ra.x * uz;
      let kt = 1 / a.mass + (raT * raT) / a.inertia;
      if (b) {
        const rbT = (pz - b.pos.z) * ux - (px - b.pos.x) * uz;
        kt += 1 / b.mass + (rbT * rbT) / b.inertia;
      }
      const jt = Math.min(tl / kt, mu * j);
      applyImpulse(a, px, pz, jt * ux, jt * uz);
      if (b) applyImpulse(b, px, pz, -jt * ux, -jt * uz);
    }
  }
  // push apart
  const corr = Math.max(hit.depth - 0.005, 0);
  if (b) {
    const wa = 1 / a.mass,
      wb = 1 / b.mass,
      ws = wa + wb;
    a.pos.x -= nx * corr * (wa / ws);
    a.pos.z -= nz * corr * (wa / ws);
    b.pos.x += nx * corr * (wb / ws);
    b.pos.z += nz * corr * (wb / ws);
  } else {
    a.pos.x -= nx * corr;
    a.pos.z -= nz * corr;
  }
  return j;
}

const CAR_REACH = Math.hypot(CARDIM.hw, CARDIM.hl) + 0.2; // how far a car's corner sticks out from its centre

function collideCars(a: Car, b: Car) {
  const dx = b.pos.x - a.pos.x,
    dz = b.pos.z - a.pos.z;
  if (dx * dx + dz * dz > 4 * CAR_REACH * CAR_REACH) return; // too far apart for their corners to touch
  if (Math.abs(a.pos.y - b.pos.y) > 1.15) return;
  const hit = satBoxes(
    a.pos.x,
    a.pos.z,
    a.yaw,
    CARDIM.hl,
    CARDIM.hw,
    b.pos.x,
    b.pos.z,
    b.yaw,
    CARDIM.hl,
    CARDIM.hw,
  );
  if (!hit) return;
  // rubber on both sides of the contact: the cars bounce off each other like dodgems
  const rubber = (bumperAt(a, hit.px, hit.pz) + bumperAt(b, hit.px, hit.pz)) / 2;
  const C = D.physics.collisions.cars;
  const j = resolveContact(a, b, hit, C.bounce + C.rubber * rubber, C.friction);
  if (j > 0) onCrash(a, b, hit.px, hit.pz, j, hit.nx, hit.nz);
}

function collideArena(car: Car) {
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  let worst = 0,
    wx = 0,
    wz = 0;
  for (const fl of [-1, 1])
    for (const fw of [-1, 1]) {
      const x = car.pos.x + sy * CARDIM.hl * fl + cy * CARDIM.hw * fw;
      const z = car.pos.z + cy * CARDIM.hl * fl - sy * CARDIM.hw * fw;
      const d = arenaSDF(x, z);
      if (d > worst) {
        worst = d;
        wx = x;
        wz = z;
      }
    }
  if (worst <= 0) return;
  const n = arenaNormal(wx, wz, _v1);
  const C = D.physics.collisions.edge;
  const j = resolveContact(
    car,
    null,
    { depth: worst, nx: n.x, nz: n.z, px: wx, pz: wz },
    C.bounce + C.rubber * bumperAt(car, wx, wz),
    C.friction,
  );
  if (j > 0) {
    onWallHit(car, wx, wz, j);
    impactKick(car, -n.x, -n.z, j / car.mass);
  }
}

function collideCarCircle(car: Car, o: import('./world.ts').RuntimeObstacle) {
  if (car.pos.y > o.h) return;
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  const rx = o.x - car.pos.x,
    rz = o.z - car.pos.z,
    reach = o.r + CAR_REACH;
  if (rx * rx + rz * rz > reach * reach) return; // too far apart to touch
  // in car space: the post's middle, the nearest point of the car to it, and the way out (ux, uz)
  const lx = rx * cy - rz * sy,
    lz = rx * sy + rz * cy;
  let qx = clamp(lx, -CARDIM.hw, CARDIM.hw),
    qz = clamp(lz, -CARDIM.hl, CARDIM.hl),
    ux = 0,
    uz = 0,
    depth;
  if (qx === lx && qz === lz) {
    // its middle got inside the car (a fast car moves almost 0.4 m a step): out through the nearest side
    const ex = CARDIM.hw - Math.abs(lx),
      ez = CARDIM.hl - Math.abs(lz);
    if (ex < ez) {
      ux = Math.sign(lx) || 1;
      qx = ux * CARDIM.hw;
      depth = ex + o.r;
    } else {
      uz = Math.sign(lz) || 1;
      qz = uz * CARDIM.hl;
      depth = ez + o.r;
    }
  } else {
    const d = Math.hypot(lx - qx, lz - qz);
    if (d >= o.r) return;
    ux = (lx - qx) / d;
    uz = (lz - qz) / d;
    depth = o.r - d;
  }
  const nx = cy * ux + sy * uz,
    nz = -sy * ux + cy * uz;
  const px = car.pos.x + cy * qx + sy * qz,
    pz = car.pos.z - sy * qx + cy * qz;
  if (o.brk && hitBreakable(car, o, nx, nz, (hitCar, amount) => damageCar(hitCar, amount, null, 'prop')))
    return; // a lamp post, tree or bollard that gives way
  const j = resolveContact(car, null, { depth, nx, nz, px, pz }, o.bounce ?? 0.3, o.friction ?? 0.3);
  if (j > 0) {
    onWallHit(car, px, pz, j * D.damage.wall.props);
    impactKick(car, -nx, -nz, j / car.mass);
  }
}

function collideCarBox(car: Car, o: import('./world.ts').RuntimeObstacle) {
  if (car.pos.y > o.h) return;
  const dx = o.x - car.pos.x,
    dz = o.z - car.pos.z,
    reach = Math.hypot(o.hw, o.hl) + CAR_REACH;
  if (dx * dx + dz * dz > reach * reach) return; // too far apart to touch (long buildings reach a long way)
  const hit = satBoxes(car.pos.x, car.pos.z, car.yaw, CARDIM.hl, CARDIM.hw, o.x, o.z, o.yaw, o.hl, o.hw);
  if (!hit) return;
  const j = resolveContact(car, null, hit, o.bounce ?? 0.25, o.friction ?? 0.3);
  if (j > 0) {
    onWallHit(car, hit.px, hit.pz, j);
    impactKick(car, -hit.nx, -hit.nz, j / car.mass);
  }
}

export function physicsStep(dt: number) {
  const cars = G.cars;
  for (const car of cars) stepCar(car, dt);
  for (let i = 0; i < cars.length; i++)
    for (let k = i + 1; k < cars.length; k++) collideCars(requireValue(cars[i]), requireValue(cars[k]));
  for (const car of cars) {
    for (const o of OBSTACLES) if (!o.down) (o.kind === 'circle' ? collideCarCircle : collideCarBox)(car, o);
    collideArena(car);
  }
}

// ---------------------------------------------------------------------
//  Damage: the chassis and whatever sits behind the hit; hard knocks crack the windows
// ---------------------------------------------------------------------
// how much each side of the car feels a knock: the front is built to take it (data/damage.json zones)
const ZONE_MULT = D.damage.zones;

// Is there rubber where this car was touched? 1 = a whole bumper, 0 = bare metal.
function bumperAt(car: Car, px: number, pz: number) {
  const p = car.bumpers[ZONE_BUMPER[zoneAt(car, px, pz)]];
  return p ? bumperLeft(p) / p.pieces.length : 0;
}

// The car rocks, tilts and (on a hard knock) hops, and loses its grip for a moment.
// (nx, nz) = the direction the car was pushed.
function impactKick(car: Car, nx: number, nz: number, dv: number, source: Car | null = null) {
  const K = D.damage.kick;
  if (dv < K.min || !car.alive) return;
  burnCrash(car, dv);
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  const side = nx * cy - nz * sy,
    fwd = nx * sy + nz * cy; // push direction in car space
  car.lean.vr += -side * dv * K.roll; // pushed sideways: the body rolls away from the hit
  car.lean.vp += fwd * dv * K.pitch; // pushed from the front or back: it pitches
  car.stun = Math.max(car.stun, Math.min(K.stunMax, dv * K.stun));
  if (dv > K.radarAbove) damageRadar(car, (dv - K.radarAbove) * K.radar, source); // a big jolt shakes the radar loose
  if (dv > K.liftAbove && car.grounded) {
    car.vel.y += Math.min(K.liftMax, (dv - K.liftAbove) * K.lift); // a hard knock lifts it off the ground
    car.grounded = false;
  }
}

function zoneAt(car: Car, px: number, pz: number) {
  return zoneOf(toLocal(car, px, 0, pz));
}

function onCrash(a: Car, b: Car, px: number, pz: number, j: number, nx = 0, nz = 0) {
  const dvA = j / a.mass,
    dvB = j / b.mass;
  impactKick(a, -nx, -nz, dvA * 0.85, b);
  impactKick(b, nx, nz, dvB * 0.85, a);
  const la = toLocal(a, px, a.pos.y + 0.5, pz),
    lb = toLocal(b, px, b.pos.y + 0.5, pz);
  const zA = zoneOf(la),
    zB = zoneOf(lb);
  const C = D.damage.crash,
    hurt = (dv: number) => Math.max(0, dv - C.threshold) * C.per;
  hitCar(a, hurt(dvA) * ZONE_MULT[zA], b, zA, 'crash', la, dvA);
  hitCar(b, hurt(dvB) * ZONE_MULT[zB], a, zB, 'crash', lb, dvB);
  const strength = Math.max(dvA, dvB);
  if (strength > 1.5) crashFx(px, Math.min(a.pos.y, b.pos.y) + 0.6, pz, strength, a, b);
}

function onWallHit(car: Car, px: number, pz: number, j: number) {
  const dv = j / car.mass,
    W = D.damage.wall;
  if (dv < W.ignore) return;
  burnCrash(car, dv);
  const l = toLocal(car, px, car.pos.y + 0.5, pz),
    z = zoneOf(l);
  const src = G.time - car.lastHitTime < D.damage.credit.hit ? car.lastHitBy : null;
  hitCar(car, Math.max(0, dv - W.threshold) * W.per * ZONE_MULT[z], src, z, 'wall', l, dv);
  knockFx('wall', car, px, car.pos.y + 0.5, pz, dv);
}

// Coming down: a thump. A hop off a knock tops out at about 4 m/s and breaks nothing; off a ramp's lip
// the car comes down hard enough to hurt (data/damage.json landing).
function onCarLanded(car: Car, impact: number) {
  const L = D.damage.landing;
  knockFx('land', car, car.pos.x, car.pos.y, car.pos.z, impact);
  if (impact > L.hurtAbove) damageCar(car, (impact - L.hurtAbove) * L.hurt, null, 'landing');
  if (impact > L.radarAbove) damageRadar(car, (impact - L.radarAbove) * L.radar);
  if (impact > L.tyresAbove && car.alive && G.state === 'playing') {
    for (let i = 0; i < 4; i++) wearTire(car, i, (impact - L.tyresAbove) * L.tyres);
    if (impact > L.axleAbove) for (let i = 0; i < 2; i++) if (Math.random() < L.axleChance) breakAxle(car, i);
  }
}

function canHurt(car: Car) {
  return car.alive && G.state === 'playing';
}

function bodyInventory(car: Car): BodyInventory {
  return {
    panels: BODY_PANELS.filter((name) => car.parts[name]?.parent === car.body),
    wheels: car.wheels.map((wheel, index) => {
      const [x, z] = requireValue(CARDIM.wheels[index]);
      return {
        attached: wheel.attached && !car.sys.wheelOff[index],
        x,
        z,
        tyreHp: requireValue(car.sys.tireHp[index]),
        flat: car.sys.tires[index] === 0,
        axleBroken: car.sys.axles[index < 2 ? 0 : 1] === 0,
      };
    }),
  };
}

// How much of a hit the rubber takes: most of a ram, some of a paintball that hits it (data/damage.json bumpers).
export function hitCar(
  car: Car,
  amount: number,
  source: Car | null,
  zone: DamageZone | null,
  cause: DamageCause,
  local: Vector | null = null,
  dv = 0,
) {
  if (!Number.isFinite(amount) || amount <= 0.02 || !canHurt(car)) return 0;
  const BS = D.damage.bumpers;
  if (car.kit && zone) kitHit(car, zone, amount * (cause === 'gun' ? D.damage.kitGun : 1)); // the add-on parts on that side
  const bp = zone && car.bumpers[ZONE_BUMPER[zone]];
  const atHeight = !local || cause !== 'gun' || local.y < BS.lowHit; // paintballs only hit the rubber low down
  if (bp && atHeight && bumperLeft(bp) > 0) {
    const soak =
      amount *
      (cause === 'crash' || cause === 'wall' || cause === 'gun' ? BS[cause] : 0) *
      (0.4 + (0.6 * bumperLeft(bp)) / bp.pieces.length);
    bp.hp = Math.max(0, bp.hp - soak * BS.wear);
    amount -= soak;
    settleBumper(car, bp.name);
  }
  if (zone) car.zoneDmg[zone] += amount;
  // the bodywork crumples where it was hit
  if (local) {
    const l = Math.hypot(local.x, local.z) || 1;
    dentCar(
      car,
      local,
      { x: -local.x / l, y: 0, z: -local.z / l },
      cause === 'gun' ? amount * 0.6 : amount * 0.9,
    );
  }
  // knocks into cars and walls crack the glass (paintball cracks are handled where the ball lands)
  if (cause !== 'gun') crackFromKnock(car, zone, cause, dv);
  systemsHit(car, amount, zone, cause, local, dv);
  if (cause === 'crash' || cause === 'wall') {
    const released = collisionBodyDamage(
      car.bodywork,
      bodyInventory(car),
      {
        alive: car.alive,
        phase: G.state,
        cause,
        zone,
        time: G.time,
        amount,
        impact: dv,
        local,
      },
      D.damage.bodywork,
    );
    if (released.panel) detachPart(car, released.panel);
    if (released.wheel !== null) loseWheel(car, released.wheel);
  }
  return damageCar(car, amount, source, cause);
}

// Chassis damage (the car's health). Fire, and the lamp posts and trees a car flattens, go straight here.
// Returns the damage dealt: no more than the car had left, and only that scores.
export function damageCar(car: Car, amount: number, source: Car | null, cause: DamageCause) {
  const dealt = applyChassisDamage(car, amount, G.state, car.spec?.tough ?? 1, D.damage.fatigue);
  if (dealt <= 0) return 0;
  G.stats[cause] = (G.stats[cause] || 0) + dealt;
  scoreDamage(car, dealt, source);
  if (source && source !== car) {
    car.lastHitBy = source;
    car.lastHitTime = G.time;
  }
  for (const h of G.humans) if (h.car === car) h.dmgFlash = Math.min(1, h.dmgFlash + dealt * 0.045);
  setPaintDamage(car.paint, (1 - car.hp / MAX_HP) * 0.55);
  if (car.hp <= 0) {
    const killer =
      source && source !== car
        ? source
        : G.time - car.lastHitTime < D.damage.credit.wreck
          ? car.lastHitBy
          : null;
    destroyCar(car, killer, cause);
  }
  return dealt;
}

export function detachPart(car: Car, name: string, boost = 1) {
  const m = car.parts[name];
  if (!m || !m.parent) return;
  // Markers keep their body-space mount when their cosmetic supporting panel flies away.
  const turret = name === 'car_hood' ? car.turrets['hood'] : name === 'trunk' ? car.turrets['trunk'] : null;
  if (turret?.base.parent === m) car.body.attach(turret.base);
  m.updateWorldMatrix(true, false);
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion();
  m.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  m.parent.remove(m);
  delete car.parts[name];
  const out = pos.clone().sub(car.pos).setY(0).normalize();
  const vel = car.vel
    .clone()
    .multiplyScalar(0.6)
    .addScaledVector(out, rand(3, 6) * boost);
  vel.y = rand(3, 6) * boost;
  addDebris(m, pos, quat, vel, 10);
}

function destroyCar(car: Car, killer: Car | null, cause: DamageCause) {
  car.alive = false;
  car.hp = 0;
  car.sys.fire = 0;
  setPaintDamage(car.paint, 1);
  car.paint.emissiveIntensity = 0;
  car.ctrl.throttle = 0;
  car.vel.y = 7.5;
  car.grounded = false;
  car.yawRate += rand(-2.5, 2.5);
  // no fire: it goes off like a party popper, and the winner's colour gets all over the wreck
  wreckFx(car, killer, cause, car.pos.x, car.pos.y, car.pos.z);
  // The wreck opens up reliably; decisions use the same attached-part inventory as live collisions.
  for (const n of BUMPER_NAMES)
    requireValue(car.bumpers[n]).pieces.forEach((m, i) => {
      if (m && Math.random() < 0.4) tearOffBumper(car, n, i, 1.6);
    });
  const released = wreckBodyDamage(bodyInventory(car), D.damage.bodywork);
  for (const panel of released.panels) detachPart(car, panel, 1.5);
  for (const wheel of released.wheels) loseWheel(car, wheel);
  for (const p of car.kit || []) if (Math.random() < 0.85) detachKit(car, p, 1.4); // the mod kit goes everywhere
  dentCar(car, { x: 0, y: 1.2, z: 0 }, { x: 0, y: -1, z: 0 }, 6); // the roof sags
  if (killer && killer !== car) award(killer, POINTS.wreck, 'WRECK', 'wreck');
  refreshOccupantVisuals(car);
  checkRoundEnd();
}
