import { requireValue } from './required-fields.ts';
import { TAU } from './math.ts';
import type { Field, Pt } from './layout.ts';
import { LANE, PAVE, mulberry32, pointInPoly, polyInside } from './layout.ts';
import { toWorld } from './town/geometry.ts';
import type { Layout, Point } from './town/types.ts';

// ---------------------------------------------------------------------
//  Painted ground: grass round about, tarmac, pavements, kerbed islands, the streets,
//  and the markings: centre lines, give-way teeth, parking bays, a fire lane, crossings
// ---------------------------------------------------------------------
export const GROUND_PX = 12; // canvas pixels per metre
export const ROAD_W = 7; // a street's tarmac: two 3.5 m lanes
export const AREA_FILL = { lot: '#7c7f83', road: '#606367', pave: '#9c9b96', grass: '#5d8a3a' };
export const GRAIN_TILE = 256; // the side of the tile the grain repeats from, in pixels
const GRASS_GRAIN = ['rgba(30,60,20,0.5)', 'rgba(120,160,70,0.5)', 'rgba(80,120,45,0.5)'];
const TARMAC_GRAIN = ['rgba(40,42,46,0.35)', 'rgba(160,160,158,0.3)', 'rgba(90,92,96,0.4)'];

/** What painting the ground draws with: a 2D canvas context, or a stand-in for it in the tests. */
export type GroundContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'fillRect'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'ellipse'
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'save'
  | 'restore'
  | 'translate'
  | 'rotate'
  | 'setLineDash'
  | 'createRadialGradient'
>;
export interface GroundPaint {
  readonly px: number; // canvas pixels per metre
  readonly dropPads: readonly { readonly x: number; readonly z: number }[];
  readonly random: () => number;
  /** A square tile of the given side, painted by `paint`, repeated as a fill. */
  readonly pattern: (side: number, paint: (tile: GroundContext) => void) => CanvasPattern;
}
type Scale = (value: number) => number;

/** Paints a town's ground onto a canvas of round(size.w * px) by round(size.h * px) pixels. */
export function paintGround(g: GroundContext, T: Layout, o: GroundPaint): void {
  const G0 = T.size,
    px = o.px,
    W = Math.round(G0.w * px),
    H = Math.round(G0.h * px),
    marks = T.markings ?? [],
    random = o.random,
    rand = (a: number, b: number) => a + random() * (b - a),
    pick = <V>(list: readonly V[]): V => requireValue(list[Math.floor(random() * list.length)]);
  const X = (x: number) => (x - G0.x0) * px,
    Z = (z: number) => (z - G0.z0) * px,
    S = (m: number) => m * px;
  const path = (Q: Pt[], close = true) => {
    g.beginPath();
    Q.forEach(([x, z], i: number) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    if (close) g.closePath();
  };
  const seg = (a: Pt, b: Pt) => {
    g.beginPath();
    g.moveTo(X(a[0]), Z(a[1]));
    g.lineTo(X(b[0]), Z(b[1]));
    g.stroke();
  };
  // Grain (grass blades, chips in the tarmac) is drawn dot by dot into one small tile and repeated, so
  // the work stays the same however big the town is. Dot by dot over the whole canvas, the 1:1 office
  // map took some 165,000 canvas calls, and on iPhones its ground came out as plain grass.
  const grain = (colors: readonly string[], density: number) =>
    o.pattern(GRAIN_TILE, (t) => {
      for (let i = 0; i < GRAIN_TILE * GRAIN_TILE * density; i++) {
        t.fillStyle = pick(colors);
        t.fillRect(random() * GRAIN_TILE, random() * GRAIN_TILE, 2, 2);
      }
    });
  // grass everywhere first
  g.fillStyle = AREA_FILL.grass;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 300; i++) {
    const x = random() * W,
      y = random() * H,
      r = rand(30, 140),
      grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, random() < 0.5 ? 'rgba(40,70,25,0.25)' : 'rgba(140,170,80,0.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.fillStyle = grain(GRASS_GRAIN, 0.01);
  g.fillRect(0, 0, W, H);
  // the streets' tarmac, then the ground over it, in order (pavement round the edge, the streets, the blocks, what's on them)
  paintRoads(g, path, S, T);
  for (const a of T.ground ?? []) {
    path(a.poly);
    g.fillStyle = AREA_FILL[a.surface];
    g.fill();
  }
  // grain, patches and oil on the tarmac
  g.save();
  path(T.bounds.poly);
  g.clip();
  g.fillStyle = grain(TARMAC_GRAIN, 0.03);
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 110; i++) {
    const v = pick([44, 58, 132]);
    g.fillStyle = `rgba(${v},${v + 1},${v + 3},0.14)`;
    g.beginPath();
    g.ellipse(random() * W, random() * H, rand(20, 80), rand(12, 44), rand(0, 3), 0, TAU);
    g.fill();
  }
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = 'rgba(28,28,30,0.3)';
    g.lineWidth = rand(0.8, 1.3);
    g.beginPath();
    let x = random() * W,
      y = random() * H;
    g.moveTo(x, y);
    for (let k = 0; k < 10; k++) {
      x += rand(-12, 12);
      y += rand(-12, 12);
      g.lineTo(x, y);
    }
    g.stroke();
  } // tar-sealed cracks
  g.restore();
  // grass texture on the parks and islands
  let parkGrain: CanvasPattern | undefined;
  for (const a of T.ground ?? [])
    if (a.surface === 'grass' && a.poly.length >= 3) {
      g.save();
      path(a.poly);
      g.clip();
      const xs = a.poly.map((p) => X(p[0])),
        ys = a.poly.map((p) => Z(p[1]));
      const x0 = Math.min(...xs),
        y0 = Math.min(...ys);
      g.fillStyle = parkGrain ??= grain(GRASS_GRAIN, 0.08);
      g.fillRect(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
      g.restore();
    }
  // kerbs
  g.lineWidth = S(0.18);
  g.strokeStyle = '#c9c7c0';
  for (const a of T.ground ?? [])
    if (a.kerb) {
      path(a.poly);
      g.stroke();
    }
  // centre lines: yellow dashes along every street, stopping short of the junctions (and where it leaves town)
  const ends: Point[] = [
    ...(T.junctions ?? []),
    ...(T.exits ?? []).map((e): Point => [
      e.x - Math.sin(e.yaw) * (LANE + PAVE),
      e.z - Math.cos(e.yaw) * (LANE + PAVE),
    ]),
  ];
  g.lineWidth = S(0.12);
  g.strokeStyle = 'rgba(232,196,64,0.9)';
  for (const st of T.roads ?? []) {
    if (st.centre === false) continue;
    const clear = (st.width ?? ROAD_W) / 2 + PAVE;
    for (let k = 1; k < st.line.length; k++) {
      const a = requireValue(st.line[k - 1]),
        b = requireValue(st.line[k]);
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        len = Math.hypot(dx, dz),
        ux = dx / len,
        uz = dz / len;
      if (!(len > 0)) continue;
      const stops = ends
        .filter((n) => Math.abs((n[0] - a[0]) * -uz + (n[1] - a[1]) * ux) < 0.5)
        .map((n) => (n[0] - a[0]) * ux + (n[1] - a[1]) * uz);
      for (let t = 1.5; t < len - 1.5; t += 6) {
        const t1 = Math.min(t + 3, len - 1.5);
        if (stops.some((q) => q > t - clear - 0.5 && q < t1 + clear + 0.5)) continue;
        seg([a[0] + ux * t, a[1] + uz * t], [a[0] + ux * t1, a[1] + uz * t1]);
      }
    }
  }
  // give-way teeth before a junction, pointing at the drivers who must wait
  g.fillStyle = 'rgba(240,240,236,0.9)';
  for (const m of marks)
    if (m.type === 'giveWay') {
      const at = (back: number, side: number) => toWorld(m.x, m.z, m.yaw, -side, -back);
      for (let o = 0.3; o < LANE - 0.5; o += 0.9) {
        path([at(LANE + 0.3, o), at(LANE + 0.3, o + 0.6), at(LANE + 1.1, o + 0.3)]);
        g.fill();
      }
    }
  // parking bays: each double row, and an arrow in each aisle between them
  const lots = (T.ground ?? []).filter((a) => a.surface === 'lot');
  for (const m of marks)
    if (m.type === 'bays') {
      const clipLot = lots.find((a) => pointInPoly(m.x, m.z, a.poly));
      if (clipLot) {
        g.save();
        path(clipLot.poly);
        g.clip();
      }
      for (let r = 0; r < m.rows; r++) {
        const [x, z] = toWorld(m.x, m.z, m.yaw, r * 16.5, 0);
        paintBays(g, X, Z, S, { x, z, yaw: m.yaw, n: m.n, hw: 5, hl: m.n * 1.25 }, rand);
        if (r) {
          // the aisle: 6.5 m between the rows, one way along it
          const w = (lx: number, lz: number) => toWorld(m.x, m.z, m.yaw, r * 16.5 - 8.25 + lx, lz);
          g.fillStyle = 'rgba(245,245,240,0.92)';
          path([
            w(-0.25, -1.5),
            w(0.25, -1.5),
            w(0.25, 0.4),
            w(0.7, 0.4),
            w(0, 1.5),
            w(-0.7, 0.4),
            w(-0.25, 0.4),
          ]);
          g.fill();
        }
      }
      if (clipLot) g.restore();
    }
  if (T.id === 'office' && T.roads?.[0]) {
    const roadLine = T.roads[0].line;
    const offsetPts = (pts: Pt[], d: number): Pt[] =>
      pts.map((p, i) => {
        const a = requireValue(pts[Math.max(0, i - 1)]),
          b = requireValue(pts[Math.min(pts.length - 1, i + 1)]);
        const dx = b[0] - a[0],
          dz = b[1] - a[1],
          l = Math.hypot(dx, dz) || 1;
        return [p[0] + (dz / l) * d, p[1] - (dx / l) * d];
      });
    g.save();
    g.lineWidth = S(0.12);
    g.strokeStyle = 'rgba(240,240,236,0.85)';
    g.setLineDash([S(3), S(3)]);
    for (const d of [-3.15, 3.15]) {
      path(offsetPts(roadLine, d), false);
      g.stroke();
    }
    g.restore();
  }
  // fire lane hatching and crossings
  for (const m of marks) {
    if (m.type === 'hatch') {
      g.save();
      path(m.poly);
      g.clip();
      g.strokeStyle = 'rgba(232,196,64,0.9)';
      g.lineWidth = S(0.25);
      const xs = m.poly.map((p) => X(p[0])),
        ys = m.poly.map((p) => Z(p[1]));
      const x0 = Math.min(...xs),
        y0 = Math.min(...ys),
        x1 = Math.max(...xs),
        y1 = Math.max(...ys);
      for (let t = x0 - (y1 - y0); t < x1; t += S(1)) {
        g.beginPath();
        g.moveTo(t, y1);
        g.lineTo(t + (y1 - y0), y0);
        g.stroke();
      }
      g.restore();
      g.lineWidth = S(0.15);
      path(m.poly);
      g.stroke();
    }
    if (m.type === 'zebra') {
      const [a, b] = m.line,
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        len = Math.hypot(dx, dz),
        ux = dx / len,
        uz = dz / len,
        d = m.depth / 2;
      g.fillStyle = 'rgba(240,240,236,0.9)';
      for (let s = 0.3; s < len - 0.3; s += 1) {
        const cx = a[0] + ux * s,
          cz = a[1] + uz * s;
        path([
          [cx - uz * d, cz + ux * d],
          [cx - uz * d + ux * 0.5, cz + ux * d + uz * 0.5],
          [cx + uz * d + ux * 0.5, cz - ux * d + uz * 0.5],
          [cx + uz * d, cz - ux * d],
        ]);
        g.fill();
      }
    }
  }
  // drop pads: a yellow ring with a cross, where supply drops come down
  g.strokeStyle = 'rgba(255,194,75,0.95)';
  g.lineWidth = S(0.3);
  for (const p of o.dropPads) {
    g.beginPath();
    g.arc(X(p.x), Z(p.z), S(1.85), 0, TAU);
    g.stroke();
    seg([p.x - 1, p.z], [p.x + 1, p.z]);
    seg([p.x, p.z - 1], [p.x, p.z + 1]);
  }
  // manhole covers and drains
  const R = mulberry32(T.seed + 7),
    cx = G0.x0 + G0.w / 2,
    cz = G0.z0 + G0.h / 2,
    hx = G0.w / 2 - 4,
    hz = G0.h / 2 - 4;
  for (let i = 0; i < 8; i++) {
    const x = cx - hx + 20 + R() * (hx * 2 - 40),
      z = cz - hz + 20 + R() * (hz * 2 - 40);
    if (polyInside(T.bounds.poly, x, z) < 8) continue;
    g.fillStyle = '#3c3d40';
    g.beginPath();
    g.arc(X(x), Z(z), S(0.35), 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(20,20,22,0.6)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(X(x), Z(z), S(0.25), 0, TAU);
    g.stroke();
  }
}
// The streets' tarmac: a strip along each one's line (round at the bends, square at the ends).
function paintRoads(g: GroundContext, path: (points: Pt[], close?: boolean) => void, S: Scale, T: Layout) {
  g.save();
  g.strokeStyle = AREA_FILL.road;
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  for (const st of T.roads ?? []) {
    g.lineWidth = S(st.width ?? ROAD_W);
    path(st.line, false);
    g.stroke();
  }
  g.restore();
}
// A double row of 2.5 x 5 m stalls: a line between every stall, the two rows split down the middle,
// two blue disabled bays with the wheelchair sign, two green bays for charging electric cars.
function paintBays(
  g: GroundContext,
  X: Scale,
  Z: Scale,
  S: Scale,
  f: Field,
  rand: (a: number, b: number) => number,
) {
  const s = Math.sin(f.yaw),
    c = Math.cos(f.yaw);
  const W = (lx: number, lz: number): Pt => [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
  const poly = (Q: Pt[]) => {
    g.beginPath();
    Q.forEach(([x, z], i: number) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.closePath();
  };
  const L = f.hl,
    x0 = -f.hw,
    R = mulberry32(Math.round(f.x * 13 + f.z * 7));
  // special bays first, under the lines
  const special: [number, number, string][] = [
    [0, 0, '#2c5ea8'],
    [1, 0, '#2c5ea8'],
    [f.n - 1, 1, 'rgba(70,170,90,0.55)'],
    [f.n - 2, 1, 'rgba(70,170,90,0.55)'],
  ];
  for (const [i, row, col] of special) {
    const a = x0 + row * 5,
      z0 = -L + i * 2.5;
    poly([W(a, z0), W(a + 5, z0), W(a + 5, z0 + 2.5), W(a, z0 + 2.5)]);
    g.fillStyle = col;
    g.fill();
    const [cx, cz] = W(a + 2.5, z0 + 1.25);
    g.save();
    g.translate(X(cx), Z(cz));
    g.rotate(-f.yaw + (row ? -Math.PI / 2 : Math.PI / 2));
    g.strokeStyle = g.fillStyle = 'rgba(245,245,240,0.92)';
    g.lineWidth = S(0.12);
    if (col.startsWith('#')) {
      // the wheelchair sign
      g.beginPath();
      g.arc(S(0.15), S(0.25), S(0.5), 0, TAU);
      g.stroke();
      g.beginPath();
      g.arc(-S(0.15), -S(0.75), S(0.17), 0, TAU);
      g.fill();
      g.beginPath();
      g.moveTo(-S(0.2), -S(0.5));
      g.lineTo(-S(0.2), S(0.05));
      g.lineTo(S(0.4), S(0.05));
      g.lineTo(S(0.6), S(0.55));
      g.stroke();
    } else {
      // a lightning bolt: charging
      g.beginPath();
      g.moveTo(S(0.15), -S(0.7));
      g.lineTo(-S(0.3), S(0.08));
      g.lineTo(S(0.02), S(0.08));
      g.lineTo(-S(0.15), S(0.7));
      g.lineTo(S(0.3), -S(0.08));
      g.lineTo(-S(0.02), -S(0.08));
      g.closePath();
      g.fill();
    }
    g.restore();
  }
  // oil drips in some of the bays
  for (let i = 0; i < f.n; i++)
    for (let row = 0; row < 2; row++)
      if (R() < 0.3) {
        const [cx, cz] = W(x0 + row * 5 + 2.5 + (R() - 0.5), -L + i * 2.5 + 1.25);
        g.fillStyle = 'rgba(30,30,32,0.22)';
        g.beginPath();
        g.ellipse(X(cx), Z(cz), S(rand(0.4, 0.8)), S(rand(0.3, 0.6)), rand(0, 3), 0, TAU);
        g.fill();
      }
  g.strokeStyle = 'rgba(245,245,240,0.92)';
  g.lineWidth = S(0.12);
  const line = (a: Pt, b: Pt) => {
    g.beginPath();
    g.moveTo(X(a[0]), Z(a[1]));
    g.lineTo(X(b[0]), Z(b[1]));
    g.stroke();
  };
  for (let i = 0; i <= f.n; i++) {
    const z = -L + i * 2.5;
    line(W(x0, z), W(x0 + 10, z));
  }
  line(W(x0 + 5, -L), W(x0 + 5, L));
  for (const xe of [x0, x0 + 10]) for (const z of [-L, L]) line(W(xe, z), W(xe, z + (z < 0 ? 0.6 : -0.6))); // short end marks
}
