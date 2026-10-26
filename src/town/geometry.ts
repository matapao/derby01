/**
 * Plain geometry on the map, for code that has no three.js: points in polygons, distances to an edge,
 * a placed piece's frame, and rays against round and boxy colliders. A yaw of 0 faces +z; a thing's
 * local +x is its left (cos yaw, -sin yaw), as for the cars.
 */
import type { Point } from './types.ts';

export function insidePoly(x: number, z: number, P: readonly Point[]): boolean {
  let yes = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[j]!,
      [bx, bz] = P[i]!;
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) yes = !yes;
  }
  return yes;
}

/** Signed distance to the polygon's edge: negative inside. */
export function edgeDistance(x: number, z: number, P: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[j]!,
      [bx, bz] = P[i]!;
    const ex = bx - ax,
      ez = bz - az,
      l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return insidePoly(x, z, P) ? -best : best;
}

/** A point in a placed thing's own frame (lx to its left, lz forward) on the map. */
export function toWorld(x: number, z: number, yaw: number, lx: number, lz: number): Point {
  const s = Math.sin(yaw),
    c = Math.cos(yaw);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

/** The four corners of a box (half sizes hw across, hl along its yaw). */
export function boxCorners(x: number, z: number, yaw: number, hw: number, hl: number): Point[] {
  return [
    [-hw, -hl],
    [hw, -hl],
    [hw, hl],
    [-hw, hl],
  ].map(([lx, lz]) => toWorld(x, z, yaw, lx!, lz!));
}

/** How far along a ray from (ox, oz) in direction (dx, dz) (a unit vector) it meets a circle, or Infinity. */
export function rayCircle(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  cx: number,
  cz: number,
  r: number,
): number {
  const fx = ox - cx,
    fz = oz - cz;
  const b = fx * dx + fz * dz,
    c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0; // starting inside
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

/** The same for a box: centre, yaw, half sizes. */
export function rayBox(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  x: number,
  z: number,
  yaw: number,
  hw: number,
  hl: number,
): number {
  const s = Math.sin(yaw),
    c = Math.cos(yaw);
  const rx = ox - x,
    rz = oz - z;
  const o = [rx * c - rz * s, rx * s + rz * c],
    d = [dx * c - dz * s, dx * s + dz * c],
    h = [hw, hl];
  let t0 = 0,
    t1 = Infinity;
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]!) < 1e-9) {
      if (Math.abs(o[i]!) > h[i]!) return Infinity;
      continue;
    }
    let a = (-h[i]! - o[i]!) / d[i]!,
      b = (h[i]! - o[i]!) / d[i]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** How far along a ray it meets the polygon's edge. */
export function rayEdge(ox: number, oz: number, dx: number, dz: number, P: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[j]!,
      [bx, bz] = P[i]!;
    const ex = bx - ax,
      ez = bz - az,
      den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - ox) * ez - (az - oz) * ex) / den,
      u = ((ax - ox) * dz - (az - oz) * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** The angle from a heading to a point, in radians: positive to the right. */
export function bearing(fromX: number, fromZ: number, yaw: number, toX: number, toZ: number): number {
  const a = Math.atan2(toX - fromX, toZ - fromZ) - yaw;
  return -Math.atan2(Math.sin(a), Math.cos(a));
}
