/** Car-local +Z is forward and +X is left. Pure geometry; no world or renderer state. */
export interface Vector {
  x: number;
  y: number;
  z: number;
}
export interface Pose {
  pos: Vector;
  yaw: number;
}
export interface MutableVector extends Vector {
  set(x: number, y: number, z: number): this;
}
export type DamageZone = 'front' | 'rear' | 'lf' | 'lr' | 'rf' | 'rr';
export const CAR_HALF_LENGTH = 2.5;

export function carToWorld<T extends MutableVector>(
  car: Pose,
  lx: number,
  ly: number,
  lz: number,
  out: T,
): T {
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  return out.set(car.pos.x + lx * cy + lz * sy, car.pos.y + ly, car.pos.z - lx * sy + lz * cy);
}
export function aimDir<T extends MutableVector>(yaw: number, pitch: number, out: T): T {
  const cp = Math.cos(pitch);
  return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
}

export function toLocal(car: Pose, px: number, py: number, pz: number): Vector {
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  const rx = px - car.pos.x,
    rz = pz - car.pos.z;
  return { x: rx * cy - rz * sy, y: py - car.pos.y, z: rx * sy + rz * cy };
}
export function zoneOf(l: Vector): DamageZone {
  if (l.z > CAR_HALF_LENGTH * 0.62) return 'front';
  if (l.z < -CAR_HALF_LENGTH * 0.62) return 'rear';
  return l.x > 0 ? (l.z > -0.1 ? 'lf' : 'lr') : l.z > -0.1 ? 'rf' : 'rr';
}

// Slab test against a yawed box: centre (x, y0..y0+h, z), half extents hw (left), hl (forward).
// The entered face: axis 0 = sides, 1 = top/bottom, 2 = front/back.
export interface BoxHit {
  t: number;
  axis: number;
  sign: number;
}
export function intersectBox(
  o: Vector,
  d: Vector,
  x: number,
  y0: number,
  z: number,
  yaw: number,
  hw: number,
  h: number,
  hl: number,
  maxT: number,
): BoxHit | null {
  const s = Math.sin(yaw),
    c = Math.cos(yaw);
  const rx = o.x - x,
    rz = o.z - z;
  const ol = [rx * c - rz * s, o.y - y0, rx * s + rz * c] as const;
  const dl = [d.x * c - d.z * s, d.y, d.x * s + d.z * c] as const;
  const lo = [-hw, 0, -hl] as const,
    hi = [hw, h, hl] as const;
  let t0 = 0,
    t1 = maxT,
    ax: 0 | 1 | 2 | null = null;
  for (const i of [0, 1, 2] as const) {
    if (Math.abs(dl[i]) < 1e-8) {
      if (ol[i] < lo[i] || ol[i] > hi[i]) return null;
      continue;
    }
    let a = (lo[i] - ol[i]) / dl[i],
      b = (hi[i] - ol[i]) / dl[i];
    if (a > b) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a > t0) {
      t0 = a;
      ax = i;
    }
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (t0 <= 0 || ax === null) return null;
  return { t: t0, axis: ax, sign: dl[ax] > 0 ? -1 : 1 };
}
/** Distance-only query for camera clipping. No shared face scratch state. */
export function rayBox(
  o: Vector,
  d: Vector,
  x: number,
  y0: number,
  z: number,
  yaw: number,
  hw: number,
  h: number,
  hl: number,
  maxT: number,
): number | null {
  return intersectBox(o, d, x, y0, z, yaw, hw, h, hl, maxT)?.t ?? null;
}
// World normal of a face of a yawed box.
export function boxNormal<T extends MutableVector>(yaw: number, axis: number, sign: number, out: T): T {
  const s = Math.sin(yaw),
    c = Math.cos(yaw);
  if (axis === 0) return out.set(c * sign, 0, -s * sign);
  if (axis === 1) return out.set(0, sign, 0);
  return out.set(s * sign, 0, c * sign);
}
