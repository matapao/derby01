import { requireValue } from './required-fields.ts';
import { TAU, clamp } from './math.ts';
import recipe from '../data/generator.json' with { type: 'json' };

// =====================================================================
//  The map: a small town laid out at random from a map number, three blocks each way. A ring road you
//  can lap all the way round, an open square in the middle (the office car park, with its bays,
//  islands, kiosk and the office building with the concrete deck and the yellow canopy) to brawl and
//  drift in, and the blocks round it: brick and white office buildings, some with an alley through as
//  a short cut, a little park with the pavilion, a small car park. Every street has two lanes and a
//  pavement on each side. The town is sized for the number of cars. Outside the ring the town goes on;
//  beyond it the farms, the fjord and the mountains.
//  The same number always gives the same map. 1 unit = 1 m, x = east, z = south.
//
//  This module only works out the plan (plain data, no three.js, no DOM), so it runs and is tested in
//  Node; arena.ts paints and builds it.
// =====================================================================
export type Pt = [number, number];
/** A box on the ground: centre, half width (local x), half length (local z), yaw (local z = (sin yaw, cos yaw)). */
export interface Box {
  x: number;
  z: number;
  hw: number;
  hl: number;
  yaw: number;
}
export type Look = 'brick' | 'white' | 'pavilion' | 'kiosk' | 'redshed' | 'wood';
export interface Building extends Box {
  h: number;
  look?: Look;
  outer?: boolean;
}
export interface Deck extends Box {
  h: number;
  round: number;
}
export interface Field extends Box {
  n: number;
} // a double row of n bays a side, back to back
export interface Area {
  poly: Pt[];
  kind: 'lot' | 'road' | 'pave' | 'grass';
  kerb?: boolean;
}
export interface Mark {
  hatch?: Pt[];
  yaw?: number;
  zebra?: Pt[];
  depth?: number;
}
export interface Street {
  a: Pt;
  b: Pt;
  ring?: boolean;
}
export interface Exit {
  x: number;
  z: number;
  dir: Pt;
  bar: Pt[];
}
/** The whole map, as plain data. */
export interface Plan {
  seed: number;
  hx: number;
  hz: number; // the edge is within ±hx, ±hz of the middle (0, 0)
  bounds: Pt[]; // the edge of the playable area
  rect: { x0: number; z0: number; w: number; h: number }; // the painted ground
  areas: Area[]; // what the ground is painted with, in order
  streets: Street[];
  nodes: Pt[];
  exits: Exit[];
  buildings: Building[];
  decks: Deck[];
  stairs: Building[];
  canopies: { x: number; z: number; yaw: number; along: Pt; inward: Pt }[];
  trees: Pt[];
  poplars: Pt[];
  lamps: Pt[];
  bollards: Pt[];
  boulders: [number, number, number][];
  fields: Field[];
  marks: Mark[];
  hedges: { a: Pt; b: Pt }[];
  north: { a: Pt; b: Pt }[];
  menuCam: { cx: number; cz: number; rx: number; rz: number; h: number };
  regions: { name: string; kind: 'square' | 'park' | 'lot' | 'offices'; poly: Pt[] }[]; // the blocks, named (for the plan agents see)
}

/** Seeded random numbers in [0, 1): the same seed gives the same run. */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const LANE = 3.5,
  PAVE = 2.5,
  SH = LANE + PAVE; // a street: two 3.5 m lanes; 6 m from its centre line to the blocks

// a box on the ground: centre, half width (local x) / half length (local z), yaw (local z = (sin yaw, cos yaw))
export const boxCorners = (b: Box, pad = 0): Pt[] => {
  const s = Math.sin(b.yaw),
    c = Math.cos(b.yaw),
    hw = b.hw + pad,
    hl = b.hl + pad;
  return (
    [
      [-hw, -hl],
      [hw, -hl],
      [hw, hl],
      [-hw, hl],
    ] satisfies Pt[]
  ).map(([x, z]): Pt => [b.x + x * c + z * s, b.z - x * s + z * c]);
};
// how far apart two boxes are (0 when they overlap), checked on the corners and edges of both
function boxGap(a: Box, b: Box): number {
  const inside = (p: Pt, q: Box) => {
    const s = Math.sin(q.yaw),
      c = Math.cos(q.yaw),
      lx = (p[0] - q.x) * c - (p[1] - q.z) * s,
      lz = (p[0] - q.x) * s + (p[1] - q.z) * c;
    return Math.hypot(Math.max(Math.abs(lx) - q.hw, 0), Math.max(Math.abs(lz) - q.hl, 0));
  };
  let d = Infinity;
  for (const p of boxCorners(a)) d = Math.min(d, inside(p, b));
  for (const p of boxCorners(b)) d = Math.min(d, inside(p, a));
  return d;
}
// distance from a point to the edge of a polygon (positive inside)
export function polyInside(P: Pt[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const ax = requireValue(P[j])[0],
      az = requireValue(P[j])[1],
      ex = requireValue(P[i])[0] - ax,
      ez = requireValue(P[i])[1] - az,
      l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return pointInPoly(x, z, P) ? best : -best;
}
const rectPoly = (x0: number, z0: number, x1: number, z1: number): Pt[] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];
function boxOf(x0: number, z0: number, x1: number, z1: number): Box;
function boxOf<T extends object>(x0: number, z0: number, x1: number, z1: number, more: T): Box & T;
function boxOf(x0: number, z0: number, x1: number, z1: number, more = {}) {
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: (x1 - x0) / 2, hl: (z1 - z0) / 2, yaw: 0, ...more };
}
// a convex polygon moved in by d on every side
function insetPoly(Q: Pt[], d: number): Pt[] {
  Q = Q.filter((p, i) => {
    const q = requireValue(Q[(i + Q.length - 1) % Q.length]);
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  }); // (no zero-length edges)
  const lines = Q.map((p, i): [number, number, number, number] => {
    const q = requireValue(Q[(i + 1) % Q.length]),
      dx = q[0] - p[0],
      dz = q[1] - p[1],
      l = Math.hypot(dx, dz);
    let nx = -dz / l,
      nz = dx / l;
    if (!pointInPoly((p[0] + q[0]) / 2 + nx * 0.01, (p[1] + q[1]) / 2 + nz * 0.01, Q)) {
      nx = -nx;
      nz = -nz;
    }
    return [p[0] + nx * d, p[1] + nz * d, dx, dz];
  });
  return lines.map((L1, i): Pt => {
    const L0 = requireValue(lines[(i + lines.length - 1) % lines.length]),
      den = L0[2] * L1[3] - L0[3] * L1[2];
    if (Math.abs(den) < 1e-9) return [L1[0], L1[1]]; // two edges in a line: the corner just moves in
    const t = ((L1[0] - L0[0]) * L1[3] - (L1[1] - L0[1]) * L1[2]) / den;
    return [L0[0] + L0[2] * t, L0[1] + L0[3] * t];
  });
}
// the part of polygon S inside the convex polygon C
function clipPoly(S: Pt[], C: Pt[]): Pt[] {
  const cx = C.reduce((s, p) => s + p[0], 0) / C.length,
    cz = C.reduce((s, p) => s + p[1], 0) / C.length;
  let out: Pt[] = S;
  for (let i = 0; i < C.length && out.length; i++) {
    const a = requireValue(C[i]),
      b = requireValue(C[(i + 1) % C.length]);
    const side = (p: Pt) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]),
      sg = Math.sign(side([cx, cz]));
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = requireValue(inp[k]),
        q = requireValue(inp[(k + 1) % inp.length]),
        sp = side(p) * sg,
        sq = side(q) * sg;
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** The generator's recipe: data/generator.json, where its sizes, chances and pieces are tuned. */
export type Recipe = typeof recipe;
export const RECIPE: Recipe = recipe;
// The first office map was the right size for eight cars: about 1,230 m² a car. Below six cars the town
// stops shrinking (smaller, and the blocks couldn't hold a building or the square a car park).
export const AREA_PER_CAR = recipe.perCar;

export function generateLayout(seed: number, cars = 4, r: Recipe = recipe): Plan {
  const R = mulberry32(seed),
    rr = (a: number | undefined, b: number | undefined) => {
      if (a === undefined || b === undefined) throw new Error('Missing generator range bound');
      return a + R() * (b - a);
    },
    chance = (p: number) => R() < p,
    rp = <T>(arr: readonly T[]): T => {
      const value = arr[(R() * arr.length) | 0];
      if (value === undefined) throw new Error('Cannot choose from an empty generator list');
      return value;
    };
  const ri = ([lo, hi]: number[]) => {
    if (lo === undefined || hi === undefined) throw new Error('Missing integer generator range bound');
    return lo + ((R() * (hi - lo + 1)) | 0);
  }; // a whole number from lo to hi
  const shuffle = <T>(arr: T[]): T[] => {
    // (seeded, and the same in every browser: a sort with a random comparator isn't)
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (R() * (i + 1)) | 0;
      [arr[i], arr[j]] = [requireValue(arr[j]), requireValue(arr[i])];
    }
    return arr;
  };
  // Three blocks each way, the middle one the square, and four streets each way round and between them:
  // the blocks' width (west and east of the square) and depth (north and south of it), and the square's.
  let bw = rr(r.blocks.w[0], r.blocks.w[1]),
    bd = rr(r.blocks.d[0], r.blocks.d[1]),
    pw = rr(r.square.w[0], r.square.w[1]),
    ph = rr(r.square.d[0], r.square.d[1]);
  // Scaled (the streets stay as wide) to the cars' area: (a k + S)(b k + S) = need.
  const S = 8 * SH,
    a = pw + 2 * bw,
    b = ph + 2 * bd,
    need = cars * r.perCar;
  const k = Math.max(
    r.minScale,
    (Math.sqrt(S * S * (a - b) ** 2 + 4 * a * b * need) - S * (a + b)) / (2 * a * b),
  );
  bw *= k;
  bd *= k;
  pw *= k;
  ph *= k;
  const hx = pw / 2 + bw + 4 * SH,
    hz = ph / 2 + bd + 4 * SH,
    W = 2 * hx,
    H = 2 * hz;
  const P: Plan = {
    seed,
    hx,
    hz,
    bounds: [],
    rect: { x0: 0, z0: 0, w: 0, h: 0 },
    areas: [],
    streets: [],
    nodes: [],
    exits: [],
    buildings: [],
    decks: [],
    stairs: [],
    canopies: [],
    trees: [],
    poplars: [],
    lamps: [],
    bollards: [],
    boulders: [],
    fields: [],
    marks: [],
    hedges: [],
    north: [],
    menuCam: { cx: 0, cz: 0, rx: 0, rz: 0, h: 0 },
    regions: [],
  };

  // ---- the edge: a rectangle with corners cut on the slant (sweeping bends on a ring road) ----
  const corners: Pt[] = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ]; // NW NE SE SW
  const cut = [0, 0, 0, 0];
  for (let n = ri(r.corners.cuts), i = 0; i < n; i++)
    cut[(R() * 4) | 0] = rr(r.corners.length[0], r.corners.length[1]) * k;
  const B: Pt[] = [];
  corners.forEach((c, i) => {
    if (!cut[i]) {
      B.push(c);
      return;
    }
    const prev = requireValue(corners[(i + 3) % 4]),
      next = requireValue(corners[(i + 1) % 4]),
      d = cut[i];
    B.push(
      [c[0] + Math.sign(prev[0] - c[0]) * d, c[1] + Math.sign(prev[1] - c[1]) * d],
      [c[0] + Math.sign(next[0] - c[0]) * d, c[1] + Math.sign(next[1] - c[1]) * d],
    );
  });
  P.bounds = B;
  P.rect = { x0: -hx - 4, z0: -hz - 4, w: W + 8, h: H + 8 };

  const foot: Box[] = []; // everything solid or kept clear, for spacing things out
  const addB = (b: Building) => {
    P.buildings.push(b);
    foot.push(b);
    return b;
  };
  const fits = (b: Box, poly: Pt[], edge = 0.4) =>
    boxCorners(b).every((p) => polyInside(poly, p[0], p[1]) >= edge);
  const roomFor = (b: Box, pad: number, poly: Pt[], edge = 1) =>
    fits(b, poly, edge) && foot.every((f) => boxGap(b, f) >= pad);
  const height = (look: Look) => (look === 'brick' ? rp(r.buildings.brick) : rp(r.buildings.white));
  // a row of buildings filling a rectangle along x or z, sometimes stepping in height or look
  const row = (x0: number, z0: number, x1: number, z1: number, look: Look) => {
    const alongX = x1 - x0 >= z1 - z0,
      len = alongX ? x1 - x0 : z1 - z0;
    for (let s = 0; s < len - 0.5;) {
      const L = len - s < 30 ? len - s : Math.min(len - s - 10, rr(14, 26));
      const more = { look, h: height(look) };
      addB(alongX ? boxOf(x0 + s, z0, x0 + s + L, z1, more) : boxOf(x0, z0 + s, x1, z0 + s + L, more));
      s += L;
      if (chance(r.buildings.switch)) look = look === 'brick' ? 'white' : 'brick';
    }
  };
  // shrink a box until it fits a cut-off corner (null when it can't)
  const fitIn = <T extends Box>(b: T, poly: Pt[]) => {
    for (let t = 0; t < 40 && !fits(b, poly); t++) {
      const bad = boxCorners(b).find((p) => polyInside(poly, p[0], p[1]) < 0.4);
      if (!bad) break;
      if (b.hw > b.hl) {
        const sx = Math.sign(bad[0] - b.x);
        b.hw -= 0.5;
        b.x -= sx * 0.5;
      } else {
        const sz = Math.sign(bad[1] - b.z);
        b.hl -= 0.5;
        b.z -= sz * 0.5;
      }
      if (b.hw < 3 || b.hl < 3) return null;
    }
    return fits(b, poly) ? b : null;
  };
  const lotArea = (poly: Pt[]) => {
    if (poly.length >= 3) P.areas.push({ poly, kind: 'lot' });
  };
  const pave = (poly: Pt[], kerb = false) => {
    if (poly.length >= 3) P.areas.push({ poly, kind: 'pave', kerb });
  };

  // The office with the concrete deck in front of it (the grey strip between it and the car park) and the
  // yellow canopy with a fire lane: along the `side` edge of the rectangle, facing in.
  const office = (x0: number, z0: number, x1: number, z1: number, side: 'N' | 'S' | 'W' | 'E') => {
    const F = ({ N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] } satisfies Record<typeof side, Pt>)[side],
      A: Pt = [Math.abs(F[1]), Math.abs(F[0])]; // towards the square / along the front
    const depth = A[0] ? z1 - z0 : x1 - x0,
      span = A[0] ? x1 - x0 : z1 - z0;
    const D = Math.min(rr(r.office.depth[0], r.office.depth[1]), depth - 1),
      sb = 0.5,
      look = rp(['brick', 'white'] as const),
      h = look === 'brick' ? rp([13.6, 17]) : 10.2;
    const L = Math.min(span - 2, rr(r.office.length[0], r.office.length[1])),
      mid = A[0] ? (x0 + x1) / 2 : (z0 + z1) / 2;
    const back = { N: z0, S: z1, W: x0, E: x1 }[side];
    const at = (s: number, d: number): Pt => (A[0] ? [mid + s, back + F[1] * d] : [back + F[0] * d, mid + s]); // s along the front, d out from the back
    const corner = (s0: number, d0: number, s1: number, d1: number) => {
      const p = at(s0, d0),
        q = at(s1, d1);
      return boxOf(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]));
    };
    addB(Object.assign(corner(-L / 2, sb, L / 2, sb + D), { look, h }));
    if (look === 'brick' && chance(r.office.stairs)) {
      // a yellow slatted stairwell on one end
      const e = chance(0.5) ? 1 : -1,
        st = Object.assign(corner(e * (L / 2), sb + D / 2 - 2, e * (L / 2 + 1), sb + D / 2 + 2), {
          h: h + 1.4,
        });
      P.stairs.push(st);
      foot.push(st);
    }
    const yaw = Math.atan2(A[0], A[1]);
    pave(boxCorners(corner(-L / 2, sb + D, L / 2, sb + D + 12.5)));
    const sd = chance(0.5) ? 1 : -1,
      dl = Math.min(r.office.deck, L * 0.5);
    const dc = at(sd * (L / 2 - 1 - dl / 2), sb + D + 5.5);
    const deck = { x: dc[0], z: dc[1], hw: 5.5, hl: dl / 2, yaw, h: 2.6, round: -sd }; // the rounded end towards the middle
    P.decks.push(deck);
    foot.push(deck);
    const m = (-sd * L) / 4,
      cc = at(m, sb + D + 1.7);
    P.canopies.push({ x: cc[0], z: cc[1], yaw, along: A, inward: F });
    P.marks.push({
      hatch: [
        at(m - 6, sb + D + 2.6),
        at(m + 6, sb + D + 2.6),
        at(m + 6, sb + D + 6.6),
        at(m - 6, sb + D + 6.6),
      ],
      yaw,
    });
    P.marks.push({ zebra: [at(m, sb + D + 6.8), at(m, sb + D + 13.5)], depth: 3.4 });
    foot.push(corner(m - 7, sb + D, m + 7, sb + D + 14)); // keep the fire lane clear
  };

  // Car park things in an open area: rows of bays, kerbed strips of grass with rowans, a round bed, the
  // kiosk with its bollards, the red shed; with `open`, a middle kept clear for donuts.
  const furnish = (
    poly: Pt[],
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    { open = false, pavilion = false, woodShed = false } = {},
  ) => {
    const place = <T extends Box & { pad?: number; edge?: number }>(
      make: (x: number, z: number) => T,
      tries = 80,
    ) => {
      for (let t = 0; t < tries; t++) {
        const b = make(rr(x0, x1), rr(z0, z1));
        if (roomFor(b, b.pad ?? 8, poly, b.edge ?? 1.5)) {
          foot.push(b);
          return b;
        }
      }
      return null;
    };
    // the pavilion and the wooden shed first (there's always room for them), then the open middle
    if (pavilion) {
      const pv = place(
        (x: number, z: number) => ({
          x,
          z,
          hw: 3,
          hl: 3.6,
          yaw: rp([0, Math.PI / 2]),
          h: 3,
          look: 'pavilion' as const,
          pad: 6,
        }),
        200,
      );
      if (pv) P.buildings.push(pv);
    }
    if (woodShed) {
      const ws = place(
        (x: number, z: number) => ({
          x,
          z,
          hw: 1.8,
          hl: 4.2,
          yaw: rp([0, Math.PI / 2]),
          h: 2.8,
          look: 'wood' as const,
          pad: 6,
        }),
        120,
      );
      if (ws) P.buildings.push(ws);
    }
    const mid = open
      ? boxOf((x0 + x1) / 2 - 9, (z0 + z1) / 2 - 7, (x0 + x1) / 2 + 9, (z0 + z1) / 2 + 7)
      : null;
    if (mid && foot.every((f) => boxGap(mid, f) > 0)) foot.push(mid);
    const lamps: Pt[] = [];
    for (let k = 0, n = ri(r.square.bays); k < n; k++) {
      const yaw = rp([0, Math.PI / 2]),
        cnt = ri(r.square.stalls);
      const f = place((x: number, z: number) => ({
        x,
        z,
        hw: 5,
        hl: cnt * 1.25,
        yaw,
        n: cnt,
        pad: 3,
        edge: 1,
      }));
      if (!f) continue;
      P.fields.push(f);
      const s = Math.sin(yaw),
        c = Math.cos(yaw);
      for (const end of [-1, 1]) {
        const lz = end * (f.hl + 1.6);
        lamps.push([f.x + lz * s, f.z + lz * c]);
      }
    }
    P.lamps.push(
      ...lamps.filter(
        (p) => !mid || Math.abs(p[0] - mid.x) > mid.hw + 1 || Math.abs(p[1] - mid.z) > mid.hl + 1,
      ),
    ); // no lamp posts where the donuts go
    for (let k = 0, n = ri(r.square.islands); k < n; k++) {
      // a kerbed strip of grass with rowans and a lamp at the end
      const yaw = rp([0, Math.PI / 2]);
      const b = place((x: number, z: number) => ({ x, z, hw: 2.2, hl: rr(6, 9), yaw, pad: 7 }));
      if (!b) continue;
      P.areas.push({ poly: boxCorners(b), kind: 'grass', kerb: true });
      const s = Math.sin(yaw),
        c = Math.cos(yaw);
      for (let t = -b.hl + 2.5; t <= b.hl - 4; t += rr(5.5, 7)) P.trees.push([b.x + s * t, b.z + c * t]);
      P.lamps.push([b.x + s * (b.hl - 1.2), b.z + c * (b.hl - 1.2)]);
    }
    const rb = place((x: number, z: number) => ({ x, z, hw: 4, hl: 4, yaw: 0, pad: 7 })); // a round bed with one big rowan
    if (rb) {
      P.areas.push({
        poly: Array.from({ length: 28 }, (_, i): Pt => [
          rb.x + Math.cos((i / 28) * TAU) * 4,
          rb.z + Math.sin((i / 28) * TAU) * 4,
        ]),
        kind: 'grass',
        kerb: true,
      });
      P.trees.push([rb.x, rb.z]);
    }
    const kyaw = rp([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const kiosk = place((x: number, z: number) => ({
      x,
      z,
      hw: 0.8,
      hl: 1.2,
      yaw: kyaw,
      h: 2.2,
      look: 'kiosk' as const,
      pad: 7,
    }));
    if (kiosk) {
      P.buildings.push(kiosk);
      const s = Math.sin(kyaw),
        c = Math.cos(kyaw);
      for (const k of [-1.2, -0.4, 0.4, 1.2])
        P.bollards.push([kiosk.x + c * k + s * 1.7, kiosk.z - s * k + c * 1.7]); // in front of the hatch
    }
    const shed = place((x: number, z: number) => ({
      x,
      z,
      hw: 0.8,
      hl: 1.1,
      yaw: rp([0, Math.PI / 2]),
      h: 2.2,
      look: 'redshed' as const,
      pad: 7,
    }));
    if (shed) P.buildings.push(shed);
  };

  const kerbIn = insetPoly(B, SH + LANE);
  {
    // ---- the town: the ring road, a square in the middle and blocks all round it ----
    const ring = insetPoly(B, SH),
      contentIn = insetPoly(B, 2 * SH);
    const xs = [-hx + SH, -pw / 2 - SH, pw / 2 + SH, hx - SH],
      zs = [-hz + SH, -ph / 2 - SH, ph / 2 + SH, hz - SH];
    const nz = 3,
      pj = 1; // cell rows; the square's
    // the streets between the cells: those touching the square border it, the others (spokes) run out to the ring
    type StreetSegment = { a: Pt; b: Pt; spoke: boolean; cells: Pt[]; removed?: boolean };
    const segs: StreetSegment[] = [];
    for (const i of [1, 2])
      for (let j = 0; j < nz; j++)
        segs.push({
          a: [requireValue(xs[i]), requireValue(zs[j])],
          b: [requireValue(xs[i]), requireValue(zs[j + 1])],
          spoke: j !== pj,
          cells: [
            [i - 1, j],
            [i, j],
          ],
        });
    for (let j = 1; j < nz; j++)
      for (let i = 0; i < 3; i++)
        segs.push({
          a: [requireValue(xs[i]), requireValue(zs[j])],
          b: [requireValue(xs[i + 1]), requireValue(zs[j])],
          spoke: i !== 1,
          cells: [
            [i, j - 1],
            [i, j],
          ],
        });
    const key = (c: Pt) => c[0] + ',' + c[1];
    const merged = new Map<string, string>();
    const merge = (s: StreetSegment | undefined) => {
      if (!s) throw new Error('Generated office has no adjoining street');
      s.removed = true;
      merged.set(key(requireValue(s.cells[0])), key(requireValue(s.cells[1])));
      merged.set(key(requireValue(s.cells[1])), key(requireValue(s.cells[0])));
    };
    // the office with the deck stands right on the square: no street between them
    const hqSide = rp(['N', 'S', 'W', 'E'] as const);
    const hqCell: Pt = { N: [1, 0], S: [1, 2], W: [0, pj], E: [2, pj] }[hqSide] as Pt;
    merge(segs.find((s) => !s.spoke && s.cells.some((c) => key(c) === key(hqCell))));
    // one or two spokes left out: two blocks become one big one, and the street ends in a T
    const onRing = (p: Pt) => Math.abs(p[0]) > hx - SH - 0.01 || Math.abs(p[1]) > hz - SH - 0.01;
    const deg = (p: Pt) =>
      segs.filter((s) => !s.removed && [s.a, s.b].some((q) => q[0] === p[0] && q[1] === p[1])).length +
      (onRing(p) ? 2 : 0);
    for (
      let n = chance(r.streets.spokes.none) ? 0 : chance(r.streets.spokes.one) ? 1 : 2, t = 0;
      n > 0 && t < 30;
      t++
    ) {
      const s = rp(segs);
      if (!s.spoke || s.removed || s.cells.some((c) => merged.has(key(c))) || deg(s.a) < 3 || deg(s.b) < 3)
        continue;
      merge(s);
      n--;
    }
    for (let i = 0; i < ring.length; i++)
      P.streets.push({ a: requireValue(ring[i]), b: requireValue(ring[(i + 1) % ring.length]), ring: true });
    for (const s of segs) if (!s.removed) P.streets.push({ a: s.a, b: s.b });
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < zs.length; j++) {
        const p: Pt = [requireValue(xs[i]), requireValue(zs[j])];
        if ((i === 0 || i === 3) && (j === 0 || j === zs.length - 1)) continue; // the ring's own corners
        if (segs.some((s) => !s.removed && [s.a, s.b].some((q) => q[0] === p[0] && q[1] === p[1])))
          P.nodes.push(p);
      }
    // where the streets meet the ring, one or two run on out of town (closed off by a barrier)
    const outs = P.nodes.filter(onRing);
    for (let n = chance(r.streets.exits.one) ? 1 : 2, t = 0; n > 0 && t < 20 && outs.length; t++) {
      const p = rp(outs);
      const dir: Pt = Math.abs(p[1]) > hz - SH - 0.01 ? [0, Math.sign(p[1])] : [Math.sign(p[0]), 0];
      if (P.exits.some((e) => e.dir[0] === dir[0] && e.dir[1] === dir[1])) continue;
      const at: Pt = [p[0] + dir[0] * SH, p[1] + dir[1] * SH],
        side: Pt = [dir[1], -dir[0]];
      P.exits.push({
        x: at[0],
        z: at[1],
        dir,
        bar: [
          [at[0] - side[0] * (LANE + 0.4), at[1] - side[1] * (LANE + 0.4)],
          [at[0] + side[0] * (LANE + 0.4), at[1] + side[1] * (LANE + 0.4)],
        ],
      });
      n--;
    }
    // ground: tarmac everywhere inside the edge, a pavement along it, the blocks on top
    P.areas.push({ poly: B, kind: 'pave' });
    P.areas.push({ poly: insetPoly(B, PAVE), kind: 'road' });
    for (const e of P.exits) {
      // the road on out across the pavement, to the barrier
      const [dx, dz] = e.dir,
        p = [e.x - dx * (PAVE + 0.5), e.z - dz * (PAVE + 0.5)],
        wx = Math.abs(dz) * LANE,
        wz = Math.abs(dx) * LANE;
      P.areas.push({
        poly: rectPoly(
          Math.min(requireValue(p[0]), e.x) - wx,
          Math.min(requireValue(p[1]), e.z) - wz,
          Math.max(requireValue(p[0]), e.x) + wx,
          Math.max(requireValue(p[1]), e.z) + wz,
        ),
        kind: 'road',
      });
    }
    const blocks = [],
      done = new Set();
    for (let cj = 0; cj < nz; cj++)
      for (let ci = 0; ci < 3; ci++) {
        const k = key([ci, cj]);
        if (done.has(k)) continue;
        let x0 = requireValue(xs[ci]),
          x1 = requireValue(xs[ci + 1]),
          z0 = requireValue(zs[cj]),
          z1 = requireValue(zs[cj + 1]);
        const part = merged.get(k);
        if (part) {
          const parts = part.split(',').map(Number);
          const pi = requireValue(parts[0]),
            pk = requireValue(parts[1]);
          x0 = Math.min(x0, requireValue(xs[pi]));
          x1 = Math.max(x1, requireValue(xs[pi + 1]));
          z0 = Math.min(z0, requireValue(zs[pk]));
          z1 = Math.max(z1, requireValue(zs[pk + 1]));
          done.add(part);
        }
        done.add(k);
        const e = 0.01; // (a hair inside, so edges that lie on the ring's aren't clipped)
        const outline = clipPoly(
          rectPoly(x0 + LANE + e, z0 + LANE + e, x1 - LANE - e, z1 - LANE - e),
          kerbIn,
        );
        const content = clipPoly(rectPoly(x0 + SH + e, z0 + SH + e, x1 - SH - e, z1 - SH - e), contentIn);
        const sq = key([1, pj]);
        blocks.push({
          x0: x0 + SH,
          z0: z0 + SH,
          x1: x1 - SH,
          z1: z1 - SH,
          outline,
          content,
          plaza: k === sq || part === sq,
          cut: content.length > 4,
        });
        pave(outline, true);
      }
    // the square: the office on one side, car park things on the rest, its middle kept open
    const plaza = blocks.find((b) => b.plaza);
    if (!plaza) throw new Error('Generated town needs a square');
    lotArea(plaza.content);
    P.regions.push({ name: 'the square', kind: 'square', poly: plaza.content });
    const [hi, hj] = hqCell;
    office(
      requireValue(xs[hi]) + SH,
      requireValue(zs[hj]) + SH,
      requireValue(xs[hi + 1]) - SH,
      requireValue(zs[hj + 1]) - SH,
      hqSide,
    );
    // the other blocks: offices (some with an alley through), a park with the pavilion, a small car park
    const others = blocks.filter((b) => !b.plaza);
    const order = shuffle(others.map((_, i) => i));
    const kinds = others.map(() => 'office');
    const cutFirst = [...order].sort(
      (a, b) => Number(requireValue(others[b]).cut) - Number(requireValue(others[a]).cut),
    ); // parks and car parks suit a cut-off corner
    if (cutFirst.length > 0) kinds[requireValue(cutFirst[0])] = 'park';
    if (cutFirst.length > 1) kinds[requireValue(cutFirst[1])] = 'lot';
    let alleys = 0;
    for (const i of order) {
      const b = requireValue(others[i]),
        kind = kinds[i],
        poly = b.content;
      const w = b.x1 - b.x0,
        d = b.z1 - b.z0,
        alongX = w >= d;
      if (kind === 'park') {
        // grass with rowans, the pavilion in the middle, a path across
        P.areas.push({ poly, kind: 'grass', kerb: true });
        P.regions.push({ name: 'the park', kind: 'park', poly });
        const cx = (b.x0 + b.x1) / 2,
          cz = (b.z0 + b.z1) / 2;
        // the pavilion in the middle (or as near it as a cut-off corner allows), turned to fit
        const offs = [0, -2, 2, -4, 4, -6, 6]
          .flatMap((dx) => [0, -2, 2, -4, 4, -6, 6].map((dz): Pt => [dx, dz]))
          .sort(
            (p, q) =>
              Math.hypot(requireValue(p[0]), requireValue(p[1])) -
                Math.hypot(requireValue(q[0]), requireValue(q[1])) ||
              requireValue(p[0]) - requireValue(q[0]) ||
              requireValue(p[1]) - requireValue(q[1]),
          );
        let pv = null;
        for (const m of [3, 1.5, 0.5]) {
          for (const yaw of [alongX ? Math.PI / 2 : 0, alongX ? 0 : Math.PI / 2]) {
            pv =
              offs
                .map(([dx, dz]) => ({
                  x: cx + dx,
                  z: cz + dz,
                  hw: 3,
                  hl: 3.6,
                  yaw,
                  h: 3,
                  look: 'pavilion' as const,
                }))
                .find((q) => fits(q, poly, m)) || null;
            if (pv) break;
          }
          if (pv) break;
        }
        if (pv) addB(pv);
        pave(
          clipPoly(
            alongX ? rectPoly(b.x0, cz - 1.25, b.x1, cz + 1.25) : rectPoly(cx - 1.25, b.z0, cx + 1.25, b.z1),
            poly,
          ),
        );
        for (let x = b.x0 + 3.5; x < b.x1 - 2; x += rr(r.park.every[0], r.park.every[1]))
          for (let z = b.z0 + 3.5; z < b.z1 - 2; z += rr(r.park.every[0], r.park.every[1])) {
            const p: Pt = [x + rr(-1.5, 1.5), z + rr(-1.5, 1.5)];
            if (polyInside(poly, p[0], p[1]) < 2.5 || Math.abs(alongX ? p[1] - cz : p[0] - cx) < 3) continue;
            if (pv && Math.hypot(p[0] - pv.x, p[1] - pv.z) < 7) continue; // room round the pavilion
            (chance(r.park.poplars) ? P.poplars : P.trees).push(p);
          }
        const lamp: Pt = alongX ? [b.x0 + w * 0.3, cz + 2] : [cx + 2, b.z0 + d * 0.3];
        if (polyInside(poly, lamp[0], lamp[1]) > 1) P.lamps.push(lamp);
        continue;
      }
      if (kind === 'lot') {
        // a small car park: bays along a long side, the wooden shed in a corner
        lotArea(poly);
        P.regions.push({ name: 'the car park', kind: 'lot', poly });
        fit: for (let n = Math.floor(((alongX ? w : d) - 8) / 2.5); n >= 4; n--)
          for (const near of [true, false])
            for (const sh of [0, -3, 3, -6, 6]) {
              const off = near ? 6 : (alongX ? d : w) - 6,
                mid = (alongX ? (b.x0 + b.x1) / 2 : (b.z0 + b.z1) / 2) + sh;
              const f = alongX
                ? { x: mid, z: b.z0 + off, hw: 5, hl: n * 1.25, yaw: Math.PI / 2, n }
                : { x: b.x0 + off, z: mid, hw: 5, hl: n * 1.25, yaw: 0, n };
              if (fits(f, poly, 0.5)) {
                P.fields.push(f);
                foot.push(f);
                break fit;
              }
            }
        const sh = Object.assign(
          alongX
            ? boxOf(b.x1 - 5.2, b.z1 - 9.4, b.x1 - 1.6, b.z1 - 1)
            : boxOf(b.x1 - 9.4, b.z1 - 5.2, b.x1 - 1, b.z1 - 1.6),
          { h: 2.8, look: 'wood' as Look },
        );
        if (fits(sh, poly, 0.3) && foot.every((f) => boxGap(sh, f) > 3)) addB(sh);
        const lamp: Pt = [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2 + (alongX ? 2 : 0)];
        if (polyInside(poly, lamp[0], lamp[1]) > 1) P.lamps.push(lamp);
        continue;
      }
      // offices: set back a little from the pavement (a paved forecourt)
      pave(poly);
      P.regions.push({
        name: `offices ${P.regions.filter((g) => g.kind === 'offices').length + 1}`,
        kind: 'offices',
        poly,
      });
      const sb = rr(0.5, 2),
        x0 = b.x0 + sb,
        z0 = b.z0 + sb,
        x1 = b.x1 - sb,
        z1 = b.z1 - sb,
        long = alongX ? x1 - x0 : z1 - z0,
        deep = alongX ? z1 - z0 : x1 - x0;
      const look = rp(['brick', 'white'] as const);
      const style =
        !b.cut && long >= 30 && (alleys === 0 || chance(r.buildings.alley))
          ? 'alley'
          : !b.cut && long >= 26 && deep >= 22 && chance(r.buildings.yard)
            ? 'L'
            : 'one';
      if (style === 'alley') {
        // two buildings with an alley between, street to street: a short cut
        alleys++;
        const aw = rr(7, 9),
          at = rr(0.38, 0.62) * long;
        if (alongX) {
          row(x0, z0, x0 + at - aw / 2, z1, look);
          row(x0 + at + aw / 2, z0, x1, z1, rp(['brick', 'white']));
          lotArea(rectPoly(x0 + at - aw / 2, b.z0 - PAVE - 0.01, x0 + at + aw / 2, b.z1 + PAVE + 0.01));
        } else {
          row(x0, z0, x1, z0 + at - aw / 2, look);
          row(x0, z0 + at + aw / 2, x1, z1, rp(['brick', 'white']));
          lotArea(rectPoly(b.x0 - PAVE - 0.01, z0 + at - aw / 2, b.x1 + PAVE + 0.01, z0 + at + aw / 2));
        }
        P.lamps.push(alongX ? [x0 + at, (z0 + z1) / 2] : [(x0 + x1) / 2, z0 + at]);
      } else if (style === 'L') {
        // an L along two sides, a yard in the open corner with a shed
        const dL = Math.min(rr(11, 14), deep - 9),
          ww = rr(9, 12),
          flipA = chance(0.5),
          flipB = chance(0.5);
        if (alongX) {
          const za = flipA ? z1 - dL : z0;
          row(x0, za, x1, za + dL, look);
          const xw = flipB ? x1 - ww : x0,
            zw0 = flipA ? z0 : z0 + dL,
            zw1 = flipA ? z1 - dL : z1;
          row(xw, zw0, xw + ww, zw1, look);
          lotArea(rectPoly(flipB ? x0 : x0 + ww, zw0, flipB ? x1 - ww : x1, zw1));
          const s = {
            x: flipB ? x1 - ww - 1.6 : x0 + ww + 1.6,
            z: flipA ? z1 - dL - 1.3 : z0 + dL + 1.3,
            hw: 0.8,
            hl: 1.1,
            yaw: 0,
            h: 2.2,
            look: 'redshed' as const,
          };
          if (foot.every((f) => boxGap(s, f) > 0.2)) addB(s);
        } else {
          const xa = flipA ? x1 - dL : x0;
          row(xa, z0, xa + dL, z1, look);
          const zw = flipB ? z1 - ww : z0,
            xw0 = flipA ? x0 : x0 + dL,
            xw1 = flipA ? x1 - dL : x1;
          row(xw0, zw, xw1, zw + ww, look);
          lotArea(rectPoly(xw0, flipB ? z0 : z0 + ww, xw1, flipB ? z1 - ww : z1));
        }
      } else {
        // one block of buildings, filling it (cut back where a corner is cut off)
        const full = fitIn(boxOf(x0, z0, x1, z1), poly);
        if (full) row(full.x - full.hw, full.z - full.hl, full.x + full.hw, full.z + full.hl, look);
        else {
          // too cut off for one: a pocket of grass with a rowan
          P.areas.push({ poly, kind: 'grass', kerb: true });
          const c: Pt = [
            poly.reduce((t, p) => t + p[0], 0) / poly.length,
            poly.reduce((t, p) => t + p[1], 0) / poly.length,
          ];
          if (polyInside(poly, c[0], c[1]) > 2) P.trees.push(c);
        }
      }
    }
    // the square's car park things last (with the pavilion, if the park had no room for it)
    furnish(plaza.content, -pw / 2, -ph / 2, pw / 2, ph / 2, {
      open: true,
      pavilion: !P.buildings.some((b) => b.look === 'pavilion'),
    });
  }
  for (const e of P.exits) {
    const [dx, dz] = e.dir;
    for (const sg of [-1, 1])
      P.boulders.push([
        e.x + dz * sg * (LANE + 2.4) + dx * 1.6,
        e.z - dx * sg * (LANE + 2.4) + dz * 1.6,
        rr(0.55, 0.8),
      ]); // boulders either side, outside
  }

  // ---- along the streets: lamp posts on the pavements, rowans along some of them ----
  const nearNode = (x: number, z: number, r: number) =>
    P.nodes.some((n) => Math.hypot(n[0] - x, n[1] - z) < r) ||
    P.exits.some((e) => Math.hypot(e.x - x, e.z - z) < r);
  for (const s of P.streets) {
    const dx = s.b[0] - s.a[0],
      dz = s.b[1] - s.a[1],
      len = Math.hypot(dx, dz),
      ux = dx / len,
      uz = dz / len,
      rx = -uz,
      rz = ux;
    const inner = (sg: number) =>
      !s.ring ||
      pointInPoly(
        s.a[0] + (ux * len) / 2 + rx * sg * (LANE + 1.25),
        s.a[1] + (uz * len) / 2 + rz * sg * (LANE + 1.25),
        kerbIn,
      );
    let side = chance(0.5) ? 1 : -1;
    for (let t = rr(6, 12); t < len - 6; t += rr(r.lamps.every[0], r.lamps.every[1])) {
      const x = s.a[0] + ux * t + rx * side * (LANE + 0.6),
        z = s.a[1] + uz * t + rz * side * (LANE + 0.6);
      side = -side;
      if (!nearNode(x, z, 9)) P.lamps.push([x, z]);
    }
    if (len < 16 || !chance(s.ring ? r.trees.ring : r.trees.streets)) continue;
    for (const sg of [-1, 1]) {
      if (!inner(sg)) continue;
      for (let t = rr(5, 9); t < len - 5; t += rr(r.trees.every[0], r.trees.every[1])) {
        const x = s.a[0] + ux * t + rx * sg * (LANE + 1.25),
          z = s.a[1] + uz * t + rz * sg * (LANE + 1.25);
        if (!nearNode(x, z, 10)) (chance(r.trees.poplars) ? P.poplars : P.trees).push([x, z]);
      }
    }
  }

  // ---- outside the edge the town goes on: a row of buildings all round, hedges in the gaps, the exits open ----
  for (let i = 0; i < B.length; i++) {
    const a = requireValue(B[i]),
      b = requireValue(B[(i + 1) % B.length]),
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      len = Math.hypot(dx, dz),
      ux = dx / len,
      uz = dz / len;
    let nx = -uz,
      nz = ux;
    if (pointInPoly((a[0] + b[0]) / 2 + nx * 0.1, (a[1] + b[1]) / 2 + nz * 0.1, B)) {
      nx = -nx;
      nz = -nz;
    }
    const yaw = Math.atan2(ux, uz);
    if (nz < -0.7) P.north.push({ a, b });
    const hedge = (s0: number, s1: number) => {
      if (s1 - s0 > 0.1)
        P.hedges.push({ a: [a[0] + ux * s0, a[1] + uz * s0], b: [a[0] + ux * s1, a[1] + uz * s1] });
    };
    const gaps = P.exits
      .filter((e) => Math.abs((e.x - a[0]) * -uz + (e.z - a[1]) * ux) < 1)
      .map((e) => (e.x - a[0]) * ux + (e.z - a[1]) * uz)
      .filter((t) => t > 0 && t < len);
    for (let s = 0; s < len - 1;) {
      const g = gaps.find((t) => t > s - 8 && t < s + 30);
      if (g !== undefined && g - 8 <= s) {
        s = g + 8.5;
        continue;
      } // (the extra half metre: g + 8 - 8 can round to just under g)
      const L = Math.min(rr(12, 26), len - s, g !== undefined ? g - 8 - s : Infinity);
      if (L < 7) {
        hedge(s, s + L);
        s += L;
        continue;
      }
      const D = rr(10, 14),
        lk = rp(['brick', 'white'] as const);
      const c: Pt = [a[0] + ux * (s + L / 2) + (nx * D) / 2, a[1] + uz * (s + L / 2) + (nz * D) / 2];
      P.buildings.push({ x: c[0], z: c[1], hw: D / 2, hl: L / 2, yaw, h: height(lk), look: lk, outer: true });
      s += L;
      if (len - s > 1 && chance(0.3)) {
        const gl = Math.min(rr(2, 5), len - s);
        hedge(s, s + gl);
        s += gl;
      }
    }
  }

  // no trees or lamps against a wall
  const solid = [...P.buildings, ...P.decks, ...P.stairs];
  const gapTo = (p: Pt, b: Box) => {
    const s = Math.sin(b.yaw),
      c = Math.cos(b.yaw),
      lx = (p[0] - b.x) * c - (p[1] - b.z) * s,
      lz = (p[0] - b.x) * s + (p[1] - b.z) * c;
    return Math.hypot(Math.max(Math.abs(lx) - b.hw, 0), Math.max(Math.abs(lz) - b.hl, 0));
  };
  for (const [list, pad] of [
    [P.trees, 2.2],
    [P.poplars, 1.6],
    [P.lamps, 0.8],
  ] as [Pt[], number][]) {
    const keep = list.filter((p) => solid.every((b) => gapTo(p, b) > pad));
    list.length = 0;
    list.push(...keep);
  }
  P.menuCam = { cx: 0, cz: 0, rx: hx * 0.75, rz: hz * 0.75, h: 12 + hx * 0.25 };
  return P;
}

export function pointInPoly(x: number, z: number, P: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if (
      requireValue(P[j])[1] > z !== requireValue(P[i])[1] > z &&
      x <
        ((requireValue(P[i])[0] - requireValue(requireValue(P[j])[0])) * (z - requireValue(P[j])[1])) /
          (requireValue(P[i])[1] - requireValue(P[j])[1]) +
          requireValue(P[j])[0]
    )
      inside = !inside;
  }
  return inside;
}
