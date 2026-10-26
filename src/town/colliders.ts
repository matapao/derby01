/**
 * What is solid in a town: every placed piece's collider (from its entry in data/pieces.json) and
 * the walls that collide, as circles and boxes on the ground, in one fixed order. The engine, the play
 * adapter and check() all build this list with the same function, so a prop's number (which the host
 * sends when one is knocked over) means the same thing everywhere.
 */
import { toWorld } from './geometry.ts';
import type { Component, Layout, Piece, Placement, Point, Prefab } from './types.ts';

export interface Obstacle {
  kind: 'circle' | 'box';
  x: number;
  z: number;
  /** Circles. */
  r: number;
  /** Boxes: half width (across the yaw) and half length (along it). */
  hw: number;
  hl: number;
  yaw: number;
  h: number;
  /** Which placement it belongs to (its index in the expanded layout's pieces), or -1 for a wall. */
  index: number;
  piece: string;
  breakable?: Extract<Component, { type: 'breakable' }>;
  /** How a car bounces off it and slides along it (its solid component). */
  bounce?: number;
  friction?: number;
}

/** The layout with its prefabs placed: everything in one flat list, prefabs' things after the layout's own. */
export function expand(layout: Layout, prefabs: readonly Prefab[] = []): Layout {
  const pf = new Map(prefabs.map((p) => [p.id, p]));
  const out: Layout = {
    ...layout,
    ground: [...(layout.ground ?? [])],
    pieces: [...(layout.pieces ?? [])],
    markings: [...(layout.markings ?? [])],
    walls: [...(layout.walls ?? [])],
    barriers: [...(layout.barriers ?? [])],
    prefabs: [],
  };
  for (const use of layout.prefabs ?? []) {
    const p = pf.get(use.prefab);
    if (!p) continue;
    const yaw = use.yaw ?? 0;
    const at = (q: Point): Point => toWorld(use.x, use.z, yaw, q[0], q[1]);
    for (const g of p.ground ?? []) out.ground!.push({ ...g, poly: g.poly.map(at) });
    for (const w of p.walls ?? []) out.walls!.push({ ...w, line: w.line.map(at) });
    for (const b of p.barriers ?? []) out.barriers!.push({ line: [at(b.line[0]), at(b.line[1])] });
    for (const q of p.pieces ?? []) {
      const [x, z] = at([q.x, q.z]);
      out.pieces!.push({ ...q, x, z, yaw: (q.yaw ?? 0) + yaw });
    }
    for (const m of p.markings ?? []) {
      if (m.type === 'hatch') out.markings!.push({ ...m, poly: m.poly.map(at) });
      else if (m.type === 'zebra') out.markings!.push({ ...m, line: [at(m.line[0]), at(m.line[1])] });
      else {
        const [x, z] = at([m.x, m.z]);
        out.markings!.push({ ...m, x, z, yaw: m.yaw + yaw });
      }
    }
  }
  return out;
}

const WALLS = { hedge: { h: 2.6, thick: 1.4 }, wall: { h: 0.9, thick: 0.6 } } as const;

/** The solid things of an expanded layout, in order: pieces as placed, then the walls that collide. */
export function colliders(layout: Layout, catalogue: readonly Piece[]): Obstacle[] {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const out: Obstacle[] = [];
  const push = (o: Omit<Obstacle, 'r' | 'hw' | 'hl' | 'yaw'> & Partial<Obstacle>): void => {
    out.push({ r: 0, hw: 0, hl: 0, yaw: 0, ...o });
  };
  (layout.pieces ?? []).forEach((p: Placement, index) => {
    const def = byId.get(p.piece);
    if (!def) return;
    const breakable = def.components.find(
      (c): c is Extract<Component, { type: 'breakable' }> => c.type === 'breakable',
    );
    const solid = def.components.find((c): c is Extract<Component, { type: 'solid' }> => c.type === 'solid');
    const yaw = p.yaw ?? 0,
      c = def.collider;
    const base = {
      index,
      piece: p.piece,
      ...(breakable ? { breakable } : {}),
      ...(solid ? { bounce: solid.bounce, friction: solid.friction } : {}),
    };
    if (c.shape === 'box') {
      push({
        ...base,
        kind: 'box',
        x: p.x,
        z: p.z,
        yaw,
        hw: (p.w ?? c.w ?? 1) / 2,
        hl: (p.l ?? c.l ?? 1) / 2,
        h: p.h ?? c.h ?? 1,
      });
    } else if (c.shape === 'circle') {
      const k = c.scaled ? (p.r ?? 1) : 1;
      push({ ...base, kind: 'circle', x: p.x, z: p.z, r: c.r * k, h: c.h * k });
    } else if (c.shape === 'posts') {
      for (const [lx, lz, r, h] of c.posts) {
        const [x, z] = toWorld(p.x, p.z, yaw, lx, lz);
        push({ ...base, kind: 'circle', x, z, r, h });
      }
    } else if (c.shape === 'rounded') {
      // a box with a half-round end towards its yaw, as wide as the box (the concrete deck)
      const hw = (p.w ?? 1) / 2,
        hl = (p.l ?? 1) / 2,
        h = p.h ?? 1;
      const [bx, bz] = toWorld(p.x, p.z, yaw, 0, -hw / 2),
        [ex, ez] = toWorld(p.x, p.z, yaw, 0, hl - hw);
      push({ ...base, kind: 'box', x: bx, z: bz, yaw, hw, hl: (2 * hl - hw) / 2, h });
      push({ ...base, kind: 'circle', x: ex, z: ez, r: hw, h });
    }
  });
  for (const w of layout.walls ?? []) {
    if (w.collide === false) continue;
    const kind = WALLS[w.kind];
    for (let i = 1; i < w.line.length; i++) {
      const [ax, az] = w.line[i - 1]!,
        [bx, bz] = w.line[i]!;
      push({
        kind: 'box',
        x: (ax + bx) / 2,
        z: (az + bz) / 2,
        yaw: Math.atan2(bx - ax, bz - az),
        hw: kind.thick / 2,
        hl: Math.hypot(bx - ax, bz - az) / 2,
        h: w.h ?? kind.h,
        index: -1,
        piece: w.kind,
        bounce: 0.25,
        friction: 0.3,
      });
    }
  }
  return out;
}
