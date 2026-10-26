import { requireValue } from './required-fields.ts';
import type { Pt, Building, Field } from './layout.ts';
import type { Piece } from './town/types.ts';
import type { BreakablePart } from './breakables.ts';
import { canvasContext } from './browser-dom.ts';
import { TOWN, DROP_PADS, setTown, setMenuCamera } from './arena-state.ts';
import * as THREE from 'three';
import { TAU, clamp, lerp, pick, rand } from './core.ts';
import {
  OBSTACLES,
  RAMPS,
  SUN_DIR,
  SURFACE,
  arenaSDF,
  buildNav,
  canvasTexture,
  polyQuery,
  scene,
  setBounds,
  setNAV,
  setSURFACE,
  sun,
} from './world.ts';
import { boxGeo } from './mesh-geometry.ts';
import { BREAKABLES, makeBreakable } from './breakables.ts';
import { LANE, PAVE, generateLayout, mulberry32, pointInPoly, polyInside } from './layout.ts';
import { D } from './data.ts';
import { colliders, expand, type Obstacle } from './town/colliders.ts';
import { fromPlan } from './town/from-plan.ts';
import { toWorld } from './town/geometry.ts';
import type { Layout, Placement, Point } from './town/types.ts';
type PlainMaterial = (color: THREE.ColorRepresentation, rough?: number) => THREE.MeshStandardMaterial;
type Scale = (value: number) => number;

// =====================================================================
//  The arena: builds a town into the scene. A town is data (src/town/types.ts, data/town.json): the
//  painted ground, the streets and their markings, the pieces placed on it (data/pieces.json: what each
//  looks like, what is solid, what gives way, ramps and drop pads), walls, barriers, the edge, and
//  the land round about. A round plays data/town.json, or the generator's town for its map number and
//  number of cars (data/rounds.json map), with its prefabs placed (data/prefabs.json).
// =====================================================================
export let ARENA_ROOT: THREE.Group | null = null; // everything the arena put in the scene

/** The town a round plays: the hand-made one, or the generator's for a map number and a number of cars. */
export function townFor(seed: number, cars: number): Layout {
  if (D.rounds.map === 'town') return D.town;
  return fromPlan(generateLayout(seed, cars, D.generator), cars, D.generator.pieces);
}

const FLOOR = 3.4;
function facadeTexture(kind: string) {
  return canvasTexture(128, 128, (g, w: number, h: number) => {
    if (kind === 'brick') {
      g.fillStyle = '#8a3a2b';
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 6)
        for (let x = (y / 6) % 2 ? -8 : 0; x < w; x += 16) {
          g.fillStyle = `rgb(${120 + rand(-18, 18)},${52 + rand(-10, 10)},${38 + rand(-8, 8)})`;
          g.fillRect(x + 1, y + 1, 14, 4);
        }
      g.fillStyle = '#6f2e22';
      g.fillRect(0, 0, 4, h); // pilaster between bays
      g.fillStyle = '#dcd8cf';
      g.fillRect(28, 46, 76, 46);
      g.fillStyle = '#2c3a48';
      g.fillRect(32, 50, 32, 38);
      g.fillRect(68, 50, 32, 38);
      g.fillStyle = 'rgba(160,190,215,0.35)';
      g.fillRect(34, 52, 12, 16);
      g.fillRect(70, 52, 12, 16);
    } else if (kind === 'white') {
      g.fillStyle = '#d9dadb';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 300; i++) {
        g.fillStyle = 'rgba(120,120,120,0.08)';
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      g.fillStyle = '#24303c';
      g.fillRect(0, 48, w, 40); // continuous ribbon window
      g.fillStyle = '#9aa3ab';
      for (let x = 0; x < w; x += 32) g.fillRect(x, 48, 3, 40);
      g.fillStyle = 'rgba(170,200,225,0.3)';
      g.fillRect(6, 52, 20, 14);
      g.fillRect(70, 52, 20, 14);
      g.fillStyle = '#bfc1c3';
      g.fillRect(0, 0, w, 3);
    } else if (kind === 'concrete') {
      g.fillStyle = '#a4a39e';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 600; i++) {
        g.fillStyle = `rgba(${pick([70, 200])},${pick([70, 200])},${pick([70, 200])},0.08)`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      g.strokeStyle = 'rgba(60,60,60,0.35)';
      g.lineWidth = 1;
      for (let x = 0; x < w; x += 32) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(0, 64);
      g.lineTo(w, 64);
      g.stroke();
    } else if (kind === 'wood') {
      g.fillStyle = '#5b3a24';
      g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 10) {
        g.fillStyle = `rgba(30,18,10,${rand(0.2, 0.5)})`;
        g.fillRect(x, 0, 2, h);
      }
    } else if (kind === 'red') {
      g.fillStyle = '#9b2b22';
      g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 10) {
        g.fillStyle = 'rgba(40,10,8,0.4)';
        g.fillRect(x, 0, 2, h);
      }
    } else if (kind === 'dark') {
      g.fillStyle = '#2f2c2a';
      g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 12) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, 0, 2, h);
      }
    } else if (kind === 'lamella') {
      g.fillStyle = '#c9971f';
      g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 8) {
        g.fillStyle = '#e8b52e';
        g.fillRect(x, 0, 5, h);
        g.fillStyle = '#8a6614';
        g.fillRect(x + 5, 0, 1, h);
      }
    } else if (kind === 'roof') {
      g.fillStyle = '#4d4f53';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 1500; i++) {
        g.fillStyle = `rgba(${pick([30, 110])},${pick([30, 110])},${pick([34, 114])},0.25)`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    } else if (kind === 'tiles') {
      g.fillStyle = '#8e3426';
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 10) {
        g.fillStyle = 'rgba(40,10,6,0.45)';
        g.fillRect(0, y, w, 2);
        for (let x = (y / 10) % 2 ? 6 : 0; x < w; x += 12) g.fillRect(x, y, 1, 10);
      }
    }
  });
}

// ---------------------------------------------------------------------
//  Painted ground: grass round about, tarmac, pavements, kerbed islands, the streets,
//  and the markings: centre lines, give-way teeth, parking bays, a fire lane, crossings
// ---------------------------------------------------------------------
const GROUND_PX = 12;
const AREA_FILL = { lot: '#7c7f83', road: '#606367', pave: '#9c9b96', grass: '#5d8a3a' };
const ROAD_W = 7; // a street's tarmac: two 3.5 m lanes
function groundTexture(T: Layout) {
  const G0 = T.size,
    px = GROUND_PX,
    W = Math.round(G0.w * px),
    H = Math.round(G0.h * px),
    marks = T.markings ?? [];
  return canvasTexture(W, H, (g) => {
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
    const speckle = (n: number, colors: string[], size: number) => {
      for (let i = 0; i < n; i++) {
        g.fillStyle = pick(colors);
        g.fillRect(Math.random() * W, Math.random() * H, size, size);
      }
    };
    // grass everywhere first
    g.fillStyle = AREA_FILL.grass;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 300; i++) {
      const x = Math.random() * W,
        y = Math.random() * H,
        r = rand(30, 140),
        grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, Math.random() < 0.5 ? 'rgba(40,70,25,0.25)' : 'rgba(140,170,80,0.22)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    speckle(W * H * 0.01, ['rgba(30,60,20,0.5)', 'rgba(120,160,70,0.5)', 'rgba(80,120,45,0.5)'], 2);
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
    speckle(W * H * 0.03, ['rgba(40,42,46,0.35)', 'rgba(160,160,158,0.3)', 'rgba(90,92,96,0.4)'], 2);
    for (let i = 0; i < 110; i++) {
      const v = pick([44, 58, 132]);
      g.fillStyle = `rgba(${v},${v + 1},${v + 3},0.14)`;
      g.beginPath();
      g.ellipse(Math.random() * W, Math.random() * H, rand(20, 80), rand(12, 44), rand(0, 3), 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = 'rgba(28,28,30,0.3)';
      g.lineWidth = rand(0.8, 1.3);
      g.beginPath();
      let x = Math.random() * W,
        y = Math.random() * H;
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
    for (const a of T.ground ?? [])
      if (a.surface === 'grass' && a.poly.length >= 3) {
        g.save();
        path(a.poly);
        g.clip();
        const xs = a.poly.map((p) => X(p[0])),
          ys = a.poly.map((p) => Z(p[1]));
        const x0 = Math.min(...xs),
          y0 = Math.min(...ys),
          x1 = Math.max(...xs),
          y1 = Math.max(...ys);
        for (let i = 0; i < (x1 - x0) * (y1 - y0) * 0.08; i++) {
          g.fillStyle = pick(['rgba(30,60,20,0.5)', 'rgba(120,160,70,0.5)', 'rgba(80,120,45,0.5)']);
          g.fillRect(rand(x0, x1), rand(y0, y1), 2, 2);
        }
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
    for (const m of marks)
      if (m.type === 'bays') {
        for (let r = 0; r < m.rows; r++) {
          const [x, z] = toWorld(m.x, m.z, m.yaw, r * 16.5, 0);
          paintBays(g, X, Z, S, { x, z, yaw: m.yaw, n: m.n, hw: 5, hl: m.n * 1.25 });
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
    for (const p of DROP_PADS) {
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
  });
}
// The streets' tarmac: a strip along each one's line (round at the bends, square at the ends).
function paintRoads(
  g: CanvasRenderingContext2D,
  path: (points: Pt[], close?: boolean) => void,
  S: Scale,
  T: Layout,
) {
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
function paintBays(g: CanvasRenderingContext2D, X: Scale, Z: Scale, S: Scale, f: Field) {
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

// paved (1) or grass (0) per square metre, drawn like the ground
function rasterGrip(T: Layout) {
  const G0 = T.size,
    w = Math.round(G0.w),
    h = Math.round(G0.h),
    cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = canvasContext(cv);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  const path = (Q: Pt[], close = true) => {
    g.beginPath();
    Q.forEach(([x, z], i: number) => (i ? g.lineTo(x - G0.x0, z - G0.z0) : g.moveTo(x - G0.x0, z - G0.z0)));
    if (close) g.closePath();
  };
  g.save();
  g.strokeStyle = '#fff';
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  for (const st of T.roads ?? []) {
    g.lineWidth = st.width ?? ROAD_W;
    path(st.line, false);
    g.stroke();
  }
  g.restore();
  for (const a of T.ground ?? []) {
    path(a.poly);
    g.fillStyle = a.surface === 'grass' ? '#000' : '#fff';
    g.fill();
  }
  const d = g.getImageData(0, 0, w, h).data,
    grid = new Uint8Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = requireValue(d[i * 4]) > 127 ? 1 : 0;
  return { x0: G0.x0, z0: G0.z0, w, h, cell: 1, grid };
}

// Waypoints for the bots, worked out from the map: points with the most room round them, at least `gap` apart.
function autoNav(gap = 15) {
  const S = SURFACE,
    cand: [number, number, number][] = [];
  for (let z = S.z0 + 1.5; z < S.z0 + S.h; z += 3)
    for (let x = S.x0 + 1.5; x < S.x0 + S.w; x += 3) {
      const edge = -arenaSDF(x, z);
      if (edge < 3.5) continue;
      let room = Math.min(edge, 12);
      for (const o of OBSTACLES) {
        let d;
        if (o.kind === 'circle') d = Math.hypot(o.x - x, o.z - z) - o.r;
        else {
          const s = Math.sin(o.yaw),
            c = Math.cos(o.yaw),
            lx = (x - o.x) * c - (z - o.z) * s,
            lz = (x - o.x) * s + (z - o.z) * c;
          d = Math.hypot(Math.max(Math.abs(lx) - o.hw, 0), Math.max(Math.abs(lz) - o.hl, 0));
        }
        if (d < room) {
          room = d;
          if (room < 2.8) break;
        }
      }
      if (room >= 2.8) cand.push([x, z, room]);
    }
  cand.sort((a, b) => requireValue(b[2]) - requireValue(a[2]));
  const nodes: Pt[] = [];
  for (const [x, z] of cand)
    if (nodes.every((q) => Math.hypot(q[0] - x, q[1] - z) >= gap)) nodes.push([x, z]);
  return buildNav(nodes);
}

// ---------------------------------------------------------------------
//  Build (and rebuild, for a new map)
// ---------------------------------------------------------------------
function disposeArena() {
  if (!ARENA_ROOT) return;
  ARENA_ROOT.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.dispose(); // (its instance buffers are only freed this way)
    if (o instanceof THREE.Mesh) o.geometry.dispose(); // (sprites share one geometry, the name tags' too)
    if (o instanceof THREE.Mesh || o instanceof THREE.Sprite)
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose();
        m.dispose();
      }
  });
  ARENA_ROOT.removeFromParent();
  ARENA_ROOT = null;
  OBSTACLES.length = 0;
  BREAKABLES.length = 0;
  RAMPS.length = 0;
  DROP_PADS.length = 0;
}

// Which look each piece's asset has (assets/assets.json): the engine knows how to draw these.
type Look =
  | 'brick'
  | 'white'
  | 'stairwell'
  | 'deck'
  | 'canopy'
  | 'kiosk'
  | 'shed-red'
  | 'shed-wood'
  | 'pavilion'
  | 'rowan'
  | 'poplar'
  | 'lamp'
  | 'boulder'
  | 'bollard'
  | 'ramp'
  | 'drop-pad';
const LOOKS: Record<string, Look> = {
  'town/building-brick': 'brick',
  'town/building-white': 'white',
  'town/stairwell': 'stairwell',
  'town/deck': 'deck',
  'town/canopy': 'canopy',
  'town/kiosk': 'kiosk',
  'town/shed-red': 'shed-red',
  'town/shed-wood': 'shed-wood',
  'town/pavilion': 'pavilion',
  'town/rowan': 'rowan',
  'town/poplar': 'poplar',
  'town/lamp': 'lamp',
  'town/boulder': 'boulder',
  'town/bollard': 'bollard',
  'town/ramp': 'ramp',
  'town/drop-pad': 'drop-pad',
};
const BUILDINGS = new Set<Look>(['brick', 'white', 'pavilion', 'shed-wood', 'kiosk', 'shed-red']);

/** Builds a town (and builds it again for the next): its ground, its pieces, its edge and the land round about. */
export function buildArena(layout: Layout) {
  disposeArena();
  const T = expand(layout, D.prefabs.prefabs);
  setTown(T);
  const catalogue = D.pieces.pieces,
    byId = new Map(catalogue.map((p) => [p.id, p]));
  const root = (ARENA_ROOT = new THREE.Group());
  scene.add(root);
  setBounds(
    T.bounds.poly.map((p) => [p[0], p[1]]),
    T.bounds.wall,
  );
  const xs = T.bounds.poly.map((p) => p[0]),
    zs = T.bounds.poly.map((p) => p[1]);
  const hx = (Math.max(...xs) - Math.min(...xs)) / 2,
    hz = (Math.max(...zs) - Math.min(...zs)) / 2;
  const cam = T.camera;
  setMenuCamera(
    cam
      ? { cx: cam.x, cz: cam.z, rx: cam.rx, rz: cam.rz, h: cam.h }
      : {
          cx: (Math.max(...xs) + Math.min(...xs)) / 2,
          cz: (Math.max(...zs) + Math.min(...zs)) / 2,
          rx: hx * 0.75,
          rz: hz * 0.75,
          h: 12 + hx * 0.25,
        },
  );
  // what is solid (the same list on every screen and for the agents: a prop's number is its place in it),
  // and the ramps and drop pads, before anything is drawn
  OBSTACLES.push(...colliders(T, catalogue));
  const solidOf = new Map<number, Obstacle[]>();
  for (const o of OBSTACLES)
    if (o.index >= 0) (solidOf.get(o.index) ?? solidOf.set(o.index, []).get(o.index)!).push(o);
  const placed = (T.pieces ?? []).map((p, index) => ({
    p,
    index,
    def: byId.get(p.piece),
    look: LOOKS[byId.get(p.piece)?.asset ?? ''],
  }));
  for (const { p, def } of placed) {
    for (const c of def?.components ?? []) {
      const yaw = p.yaw ?? 0;
      if (c.type === 'ramp')
        RAMPS.push({
          x: p.x,
          z: p.z,
          s: Math.sin(yaw),
          c: Math.cos(yaw),
          hw: (p.w ?? 4) / 2,
          hl: (p.l ?? 6) / 2,
          h: p.h ?? 1,
        });
      if (c.type === 'dropPad')
        DROP_PADS.push({ x: p.x, z: p.z, ...(c.types ? { types: [...c.types] } : {}) });
    }
  }
  const of = (look: Look) => placed.filter((q) => q.look === look);
  // a piece's size: where it is placed, else its own (data/pieces.json)
  const box = (p: Placement, d: Piece | undefined) => {
    if (!d) throw new Error(`Unknown placed piece ${p.piece}`);
    const c = d.collider;
    const dimensions: { w?: number; l?: number; h?: number } =
      c.shape === 'box' ? c : c.shape === 'circle' ? { h: c.h } : {};
    return {
      x: p.x,
      z: p.z,
      yaw: p.yaw ?? 0,
      hw: (p.w ?? dimensions.w ?? 1) / 2,
      hl: (p.l ?? dimensions.l ?? 1) / 2,
      h: p.h ?? dimensions.h ?? 1,
    };
  };
  // a breakable piece drawn as one mesh of its own tips over as a whole
  const giveWay = (index: number, kind: string, parts: BreakablePart[]) => {
    const obs = solidOf.get(index) ?? [];
    if (obs.length === 1 && requireValue(obs[0]).breakable) makeBreakable(requireValue(obs[0]), kind, parts);
  };

  // the sun's shadows cover the whole map (measured in the light's own frame)
  sun.target.position.set(0, 0, 0);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 140);
  const ly = new THREE.Vector3(0, 1, 0).addScaledVector(SUN_DIR, -SUN_DIR.y).normalize(),
    lx = new THREE.Vector3().crossVectors(ly, SUN_DIR).normalize();
  let ex = 0,
    ey = 0;
  for (const [x, z] of T.bounds.poly) {
    ex = Math.max(ex, Math.abs(x * lx.x + z * lx.z));
    ey = Math.max(ey, Math.abs(x * ly.x + z * ly.z));
  }
  Object.assign(sun.shadow.camera, {
    left: -ex - 22,
    right: ex + 22,
    top: ey + 26,
    bottom: -ey - 26,
    far: 340,
  }); // (with the row of buildings outside)
  sun.shadow.camera.updateProjectionMatrix();

  const mats: Record<string, THREE.MeshStandardMaterial> = {};
  const facade = (kind: string) =>
    mats[kind] ||
    (mats[kind] = new THREE.MeshStandardMaterial({
      map: facadeTexture(kind),
      roughness: 0.85,
      metalness: kind === 'white' ? 0.05 : 0,
    }));
  const plain = (color: THREE.ColorRepresentation, rough = 0.85) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough });

  // ground: the painted town in a big field
  const gtex = groundTexture(T);
  gtex.wrapS = gtex.wrapT = THREE.ClampToEdgeWrapping;
  const G0 = T.size;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(G0.w, G0.h),
    new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(G0.x0 + G0.w / 2, 0, G0.z0 + G0.h / 2);
  ground.receiveShadow = true;
  root.add(ground);
  setSURFACE(rasterGrip(T));

  // ---- buildings ----
  const addBox = (o: Building, matList: THREE.Material | THREE.Material[]) => {
    const m = new THREE.Mesh(boxGeo(o.hw * 2, o.h, o.hl * 2, 0, 0, 0, 0, 0, 0, FLOOR), matList);
    m.position.set(o.x, o.h / 2, o.z);
    m.rotation.y = o.yaw;
    m.castShadow = m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const roofMat = facade('roof');
  for (const { p, def, look, index } of placed.filter((q) => q.look !== undefined && BUILDINGS.has(q.look))) {
    const b = box(p, def);
    let mat;
    if (look === 'brick' || look === 'white')
      mat = [facade(look), facade(look), roofMat, roofMat, facade(look), facade(look)];
    else if (look === 'pavilion') mat = facade('brick');
    else if (look === 'shed-wood')
      mat = [facade('wood'), facade('wood'), plain(0x2b2a29), roofMat, facade('wood'), facade('wood')];
    else if (look === 'kiosk') mat = facade('dark');
    else mat = facade('red');
    giveWay(index, requireValue(look), [[addBox(b, mat), null]]);
    if (look === 'pavilion') {
      // hipped roof of red tiles
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4, 1).rotateY(Math.PI / 4), facade('tiles'));
      roof.scale.set(b.hw * 2 * 0.78, 1.6, b.hl * 2 * 0.78);
      roof.position.set(b.x, b.h + 0.8, b.z);
      roof.rotation.y = b.yaw;
      roof.castShadow = true;
      root.add(roof);
    }
    if (look === 'shed-red') {
      // a solar panel on the roof
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(b.hw * 2 + 0.2, 0.06, b.hl * 2 + 0.2),
        plain(0x1d2a4a, 0.3),
      );
      panel.position.set(b.x, b.h + 0.05, b.z);
      panel.rotation.y = b.yaw;
      root.add(panel);
    }
  }
  // yellow slatted stairwells on the ends of some brick blocks
  for (const { p, def } of of('stairwell')) addBox(box(p, def), facade('lamella'));
  // the yellow entrance canopy: slats on two posts, standing out from the wall towards its yaw
  const yellow = plain(0xe0a92a, 0.6);
  for (const { p } of of('canopy')) {
    const canopy = new THREE.Group();
    canopy.position.set(p.x, 0, p.z);
    canopy.rotation.y = p.yaw ?? 0;
    // local x = along the wall, local z = out from it
    for (const x of [-2, 2]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3, 0.14), yellow);
      post.position.set(x, 1.5, 1.6);
      canopy.add(post);
    }
    for (let i = -2; i <= 2; i += 0.5) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 3.4), yellow);
      slat.position.set(i, 3, 0);
      canopy.add(slat);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(4.3, 0.16, 0.16), yellow);
    beam.position.set(0, 2.95, 1.6);
    canopy.add(beam);
    canopy.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    root.add(canopy);
  }
  // concrete parking decks: the grey strip between the lot and a building. Straight part + a rounded end (towards its yaw), a grating on top
  for (const { p, def } of of('deck')) {
    const d = box(p, def),
      fx = Math.sin(d.yaw),
      fz = Math.cos(d.yaw),
      r = d.hw,
      straight = d.hl * 2 - r;
    const conc = facade('concrete');
    const cx = d.x - fx * (r / 2),
      cz = d.z - fz * (r / 2);
    addBox({ x: cx, z: cz, hw: d.hw, hl: straight / 2, yaw: d.yaw, h: d.h }, [
      conc,
      conc,
      roofMat,
      roofMat,
      conc,
      conc,
    ]);
    const ex = d.x + fx * (d.hl - r),
      ez = d.z + fz * (d.hl - r);
    const end = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.h, 20, 1, false, 0, Math.PI), [
      conc,
      roofMat,
      roofMat,
    ]);
    end.position.set(ex, d.h / 2, ez);
    end.rotation.y = d.yaw - Math.PI / 2;
    end.castShadow = end.receiveShadow = true;
    root.add(end);
    const grate = new THREE.MeshStandardMaterial({
      map: canvasTexture(64, 64, (g, w: number, h: number) => {
        g.clearRect(0, 0, w, h);
        g.strokeStyle = '#8d9196';
        g.lineWidth = 3;
        for (let i = 0; i <= w; i += 16) {
          g.beginPath();
          g.moveTo(i, 0);
          g.lineTo(i, h);
          g.stroke();
        }
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(0, 2);
        g.lineTo(w, 2);
        g.stroke();
        g.beginPath();
        g.moveTo(0, h - 2);
        g.lineTo(w, h - 2);
        g.stroke();
      }),
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      metalness: 0.6,
      roughness: 0.4,
    });
    grate.map?.repeat.set(12, 1);
    const none = new THREE.MeshBasicMaterial({ visible: false });
    const fence = new THREE.Mesh(new THREE.BoxGeometry(d.hw * 2, 1.1, straight), [
      grate,
      grate,
      none,
      none,
      grate,
      grate,
    ]);
    fence.position.set(cx, d.h + 0.55, cz);
    fence.rotation.y = d.yaw;
    root.add(fence);
  }

  // ---- trees, lamps, boulders, bollards (all but the boulders give way when hit hard) ----
  const leaf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const trunkMat = plain(0x4a3a2c);
  const crownGeo = (() => {
    // rowan crown with small clusters of red berries
    const g = new THREE.IcosahedronGeometry(1.6, 3);
    const n = g.getAttribute('position').count,
      col = new Float32Array(n * 3),
      tmp = new THREE.Color();
    for (let i = 0; i < n; i += 3) {
      const berry = Math.random() < 0.045,
        shade = rand(0.75, 1.05);
      if (berry) tmp.setRGB(0.66, 0.14, 0.09, THREE.SRGBColorSpace);
      else tmp.setRGB(0.27 * shade, 0.45 * shade, 0.19 * shade, THREE.SRGBColorSpace);
      for (let k = 0; k < 3; k++) col.set([tmp.r, tmp.g, tmp.b], (i + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.scale(1, 1.15, 1);
    g.computeVertexNormals();
    return g;
  })();
  const trees = of('rowan'),
    pops = of('poplar');
  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 2.6, 6).translate(0, 1.3, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, trees.length + pops.length));
  const crowns = new THREE.InstancedMesh(crownGeo, leaf, Math.max(1, trees.length));
  trunks.count = trees.length + pops.length;
  crowns.count = trees.length;
  const dummy = new THREE.Object3D();
  trees.forEach(({ p, index }, i) => {
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, rand(0, 3), 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, 3.6, p.z);
    dummy.scale.setScalar(rand(0.85, 1.15));
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    giveWay(index, 'tree', [
      [trunks, i],
      [crowns, i],
    ]);
  });
  const poplarGeo = new THREE.IcosahedronGeometry(1, 1).scale(1.1, 4.6, 1.1).translate(0, 6.5, 0);
  const poplars = new THREE.InstancedMesh(poplarGeo, plain(0x2f5a2a, 0.9), Math.max(1, pops.length));
  poplars.count = pops.length;
  pops.forEach(({ p, index }, i) => {
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    trunks.setMatrixAt(trees.length + i, dummy.matrix);
    poplars.setMatrixAt(i, dummy.matrix);
    giveWay(index, 'poplar', [
      [trunks, trees.length + i],
      [poplars, i],
    ]);
  });
  for (const m of [trunks, crowns, poplars]) {
    m.castShadow = true;
    root.add(m);
  }

  // black lamp posts with round "UFO" heads (that go dark when knocked over)
  const lamps = of('lamp');
  const pole = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.06, 0.09, 5, 6).translate(0, 2.5, 0),
    plain(0x1c1e20, 0.5),
    Math.max(1, lamps.length),
  );
  const head = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.42, 0.3, 0.16, 14).translate(0, 5.05, 0),
    plain(0x2a2c2e, 0.4),
    Math.max(1, lamps.length),
  );
  const glow = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.02, 12).translate(0, 4.96, 0),
    new THREE.MeshBasicMaterial({ color: 0xfff2c8 }),
    Math.max(1, lamps.length),
  );
  pole.count = head.count = glow.count = lamps.length;
  lamps.forEach(({ p, index }, i) => {
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    pole.setMatrixAt(i, dummy.matrix);
    head.setMatrixAt(i, dummy.matrix);
    glow.setMatrixAt(i, dummy.matrix);
    const dark = !!solidOf.get(index)?.[0]?.breakable?.dark;
    giveWay(index, 'lamp', [
      [pole, i],
      [head, i],
      [glow, i, dark],
    ]);
  });
  pole.castShadow = head.castShadow = true;
  root.add(pole, head, glow);

  // boulders either side of the roads out of town
  const rock = plain(0x8d8a84, 0.95);
  for (const { p, index } of of('boulder')) {
    const r = p.r ?? 1,
      b = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rock);
    b.position.set(p.x, r * 0.55, p.z);
    b.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    b.scale.set(1.2, 0.8, 1);
    b.castShadow = true;
    root.add(b);
    giveWay(index, 'boulder', [[b, null]]);
  }
  // red/yellow striped bollards in front of the kiosk
  const stripeTex = canvasTexture(32, 64, (g, w: number, h: number) => {
    for (let y = 0; y < h; y += 16) {
      g.fillStyle = '#d42a1e';
      g.fillRect(0, y, w, 8);
      g.fillStyle = '#f2c21b';
      g.fillRect(0, y + 8, w, 8);
    }
  });
  const bollardMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 });
  for (const { p, index } of of('bollard')) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1, 8).translate(0, 0.5, 0), bollardMat);
    b.position.set(p.x, 0, p.z);
    b.castShadow = true;
    root.add(b);
    giveWay(index, 'bollard', [[b, null]]);
  }
  // concrete ramps: drive up, fly off the lip
  const rampMat = facade('concrete');
  for (const r of RAMPS) {
    const geo = new THREE.BufferGeometry(),
      w = r.hw,
      l = r.hl,
      h = r.h;
    // near edge on the ground, far edge up at h: the slope, the back and the two sides
    const v: [number, number, number][] = [
      [-w, 0, -l],
      [w, 0, -l],
      [w, h, l],
      [-w, h, l],
      [-w, 0, l],
      [w, 0, l],
    ];
    const tris = [
      [0, 2, 1],
      [0, 3, 2],
      [3, 5, 2],
      [3, 4, 5],
      [0, 4, 3],
      [1, 2, 5],
    ];
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        tris.flat().flatMap((i) => requireValue(v[i])),
        3,
      ),
    );
    geo.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        tris
          .flat()
          .flatMap((i) => [
            requireValue(requireValue(v[i])[0]) / 4,
            (requireValue(requireValue(v[i])[2]) + requireValue(requireValue(v[i])[1])) / 4,
          ]),
        2,
      ),
    );
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rampMat);
    m.position.set(r.x, 0, r.z);
    m.rotation.y = Math.atan2(r.s, r.c);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
  }
  // low concrete walls (the hedges are drawn with the edge)
  for (const w of T.walls ?? []) {
    if (w.kind !== 'wall') continue;
    for (let i = 1; i < w.line.length; i++) {
      const a = requireValue(w.line[i - 1]),
        b = requireValue(w.line[i]),
        len = Math.hypot(b[0] - a[0], b[1] - a[1]),
        h = w.h ?? 0.9;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, len + 0.6), rampMat);
      m.position.set((a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2);
      m.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]);
      m.castShadow = m.receiveShadow = true;
      root.add(m);
    }
  }

  buildEdges(root, plain);
  if (T.backdrop !== 'none') buildBackdrop(root, plain, dummy, hx, hz);
  else {
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2),
      plain(0x5d8a3a, 1),
    );
    field.position.y = -0.3;
    field.receiveShadow = true;
    root.add(field);
  }
  setNAV(autoNav(15));
}

// ---------------------------------------------------------------------
//  Edges: clipped hedges in the gaps between the buildings round the edge, and road blocks where
//  the streets leave town
// ---------------------------------------------------------------------
function buildEdges(root: THREE.Group, plain: PlainMaterial) {
  const T = TOWN;
  if (!T) throw new Error('Town is not built');
  const segInfo = (a: Pt, b: Pt) => {
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      len = Math.hypot(dx, dz);
    return {
      x: (a[0] + b[0]) / 2,
      z: (a[1] + b[1]) / 2,
      len,
      yaw: Math.atan2(dx, dz),
      dx: dx / len,
      dz: dz / len,
    };
  };
  const hedgeTex = canvasTexture(64, 64, (g, w: number, h: number) => {
    g.fillStyle = '#2f5326';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = pick(['#24451d', '#3d6a2f', '#4b7a36', '#1c3616']);
      g.fillRect(Math.random() * w, Math.random() * h, 3, 3);
    }
  });
  hedgeTex.repeat.set(10, 1);
  const hedgeMat = new THREE.MeshStandardMaterial({ map: hedgeTex, roughness: 1 });
  for (const w of T.walls ?? []) {
    if (w.kind !== 'hedge') continue;
    for (let i = 1; i < w.line.length; i++) {
      const s = segInfo(requireValue(w.line[i - 1]), requireValue(w.line[i])),
        h = w.h ?? 2.6;
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, h, s.len), hedgeMat);
      m.position.set(s.x, h / 2, s.z);
      m.rotation.y = s.yaw;
      m.castShadow = m.receiveShadow = true;
      root.add(m);
    }
  }
  // road blocks where the streets leave town
  const stripes = canvasTexture(128, 16, (g, w: number, h: number) => {
    for (let x = 0; x < w; x += 32) {
      g.fillStyle = '#e8e4dc';
      g.fillRect(x, 0, 16, h);
      g.fillStyle = '#c8261c';
      g.fillRect(x + 16, 0, 16, h);
    }
  });
  const barMat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6 });
  const postMat = plain(0xd8d4cc, 0.6);
  for (const e of T.barriers ?? []) {
    const s = segInfo(e.line[0], e.line[1]);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, s.len), barMat);
    bar.position.set(s.x, 0.95, s.z);
    bar.rotation.y = s.yaw;
    bar.castShadow = true;
    root.add(bar);
    for (const t of [-0.45, 0, 0.45]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1).translate(0, 0.55, 0), postMat);
      p.position.set(s.x + Math.sin(s.yaw) * s.len * t, 0, s.z + Math.cos(s.yaw) * s.len * t);
      root.add(p);
    }
  }
}

// ---------------------------------------------------------------------
//  Backdrop: woods behind the town, orchards and farms up the hill, houses, the fjord and the mountains
// ---------------------------------------------------------------------
function buildBackdrop(
  root: THREE.Group,
  plain: PlainMaterial,
  dummy: THREE.Object3D,
  hx: number,
  _hz: number,
) {
  const T = TOWN;
  if (!T) throw new Error('Town is not built');
  const R = mulberry32(T.seed + 99),
    rr = (a: number, b: number) => a + R() * (b - a),
    B = T.bounds.poly;
  // the flat part: the town, and the row of buildings round it
  const xa = Math.min(...B.map((p) => p[0])) - 30,
    xb = Math.max(...B.map((p) => p[0])) + 30,
    za = Math.min(...B.map((p) => p[1])) - 30,
    zb = Math.max(...B.map((p) => p[1])) + 30;
  // where the roads leave town, and the edges that face north (the woods behind them)
  const exits = (T.exits ?? []).map((e) => ({
    x: e.x,
    z: e.z,
    dir: [Math.sin(e.yaw), Math.cos(e.yaw)] as Pt,
  }));
  const north = B.flatMap((a, i) => {
    const b = requireValue(B[(i + 1) % B.length]),
      len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1,
      ux = (b[0] - a[0]) / len,
      uz = (b[1] - a[1]) / len;
    let nz = ux;
    if (pointInPoly((a[0] + b[0]) / 2 - uz * 0.1, (a[1] + b[1]) / 2 + ux * 0.1, B)) nz = -nz;
    return nz < -0.7 ? [{ a, b }] : [];
  });
  // big field round everything, gently dropping towards the fjord in the south
  const terrainGeo = new THREE.PlaneGeometry(3000, 3000, 120, 120).rotateX(-Math.PI / 2);
  const tp = terrainGeo.getAttribute('position'),
    tcol = new Float32Array(tp.count * 3);
  const shore = (x: number) => zb + 245 + x * 0.25; // fjord shoreline (z) at a given x
  const hillH = (x: number, z: number) => {
    const near = Math.max(xa - x, x - xb, za - z, z - zb, 0);
    let y = 0;
    if (z < za) y += Math.pow(Math.min(1, (za - z) / 1100), 1.8) * 650 + (za - z) * 0.12; // gentle farmland, then the steep mountain
    if (z > shore(x) - 140) y -= Math.min(60, (z - (shore(x) - 140)) * 0.4); // down to the fjord
    y += (Math.sin(x * 0.011) + Math.cos(z * 0.013)) * 6 * Math.min(1, near / 60);
    return near < 3 ? 0 : y * Math.min(1, near / 40);
  };
  const STEP = 3000 / 120;
  const groundAt = (x: number, z: number) => {
    const gx = (x + 1500) / STEP,
      gz = (z + 1500) / STEP,
      i = Math.floor(gx),
      j = Math.floor(gz),
      fx = gx - i,
      fz = gz - j;
    const h = (a: number, b: number) => hillH(-1500 + a * STEP, -1500 + b * STEP) - 0.3;
    return lerp(lerp(h(i, j), h(i + 1, j), fx), lerp(h(i, j + 1), h(i + 1, j + 1), fx), fz);
  };
  const lowest = (x: number, z: number, r: number) =>
    Math.min(
      groundAt(x, z),
      groundAt(x - r, z - r),
      groundAt(x + r, z - r),
      groundAt(x - r, z + r),
      groundAt(x + r, z + r),
    );
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i),
      z = tp.getZ(i),
      y = hillH(x, z);
    tp.setY(i, y - 0.3); // well under the painted ground, so it never shows through from far up
    const forest = clamp((y - 50) / 90, 0, 1),
      patch = 0.85 + 0.3 * Math.abs(Math.sin(x * 0.031 + z * 0.017) * Math.cos(z * 0.023 - x * 0.011));
    const c = new THREE.Color().setRGB(
      (0.36 - forest * 0.2) * patch,
      (0.52 - forest * 0.24) * patch,
      (0.22 - forest * 0.09) * patch,
      THREE.SRGBColorSpace,
    );
    tcol.set([c.r, c.g, c.b], i * 3);
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
  terrainGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  terrain.receiveShadow = true;
  root.add(terrain);
  // the fjord
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 5000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x3f6b7f, roughness: 0.15, metalness: 0.3 }),
  );
  water.position.set(0, -38, zb + 2815);
  root.add(water);
  // mountains: steep wooded slopes behind, high bluish peaks across the fjord
  const mountain = (
    x: number,
    z: number,
    r: number,
    h: number,
    color: THREE.ColorRepresentation,
    seed: number,
  ) => {
    const g = new THREE.ConeGeometry(r, h, 9, 4, true);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > h / 2 - 1) continue;
      const k = 1 + Math.sin(i * 1.7 + seed) * 0.18;
      p.setX(i, p.getX(i) * k);
      p.setZ(i, p.getZ(i) * k);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, plain(color, 1));
    m.position.set(x, h / 2 - 40, z);
    root.add(m);
  };
  mountain(-300, -1400, 900, 1300, 0x35552c, 1);
  mountain(500, -1300, 800, 1100, 0x3b5a30, 2);
  mountain(1300, -900, 700, 900, 0x45633a, 3);
  mountain(-1300, -700, 700, 800, 0x41603a, 4);
  mountain(-900, 3600, 1300, 1400, 0x5d7590, 5);
  mountain(700, 3800, 1400, 1500, 0x667c96, 6);
  mountain(2300, 3300, 1100, 1100, 0x6e839b, 7);
  mountain(-2600, 3000, 1200, 1200, 0x6a7f97, 8);

  // keep clear: the roads out of town, and the orchard up the hill
  const onRoad = (x: number, z: number, m: number) =>
    exits.some((e) => {
      const t = (x - e.x) * requireValue(e.dir[0]) + (z - e.z) * requireValue(e.dir[1]),
        off = Math.abs((x - e.x) * requireValue(e.dir[1]) - (z - e.z) * requireValue(e.dir[0]));
      return t > -2 && t < 230 && off < LANE + PAVE + m;
    });
  const mx = (xa + xb) / 2,
    orchardX = [mx - Math.min(70, hx * 0.65), mx + Math.min(70, hx * 0.65)],
    orchardZ = za - 12;
  const inOrchard = (x: number, z: number, m: number) =>
    z < orchardZ + m &&
    z > orchardZ - 104 - m &&
    x > requireValue(orchardX[0]) - m &&
    x < requireValue(orchardX[1]) + m;
  // trees: a thick band behind the buildings to the north, scattered round the farms
  const spots: [number, number, number][] = [];
  for (const sg of north) {
    const a = sg.a,
      b = sg.b,
      n = Math.round(Math.hypot(requireValue(b[0]) - a[0], requireValue(b[1]) - a[1]) / 3.2);
    for (let k = 0; k < n; k++)
      for (let row = 0; row < 2; row++)
        spots.push([
          lerp(a[0], requireValue(b[0]), k / n) + rand(-1, 1),
          lerp(a[1], requireValue(b[1]), k / n) - 19 - row * 5.5 + rand(-1, 1),
          rand(2.6, 4),
        ]);
  }
  for (let i = 0; i < 300; i++) {
    const x = rand(xa - 45, xb + 45),
      z = rand(za - 30, zb + 40);
    if (polyQuery(x, z).d < 18 || onRoad(x, z, 4) || inOrchard(x, z, 4)) continue;
    spots.push([x, z, rand(2.4, 4.5)]);
  }
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const crowns = new THREE.InstancedMesh(
    crownGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    spots.length,
  );
  const col = new THREE.Color();
  spots.forEach(([x, z, s], i) => {
    dummy.position.set(x, groundAt(x, z) + s * 1.1, z);
    dummy.rotation.set(0, rand(0, 3), 0);
    dummy.scale.set(s, s * 1.2, s);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(
      i,
      col.setRGB(rand(0.16, 0.26), rand(0.32, 0.45), rand(0.12, 0.2), THREE.SRGBColorSpace),
    );
  });
  crowns.castShadow = true;
  root.add(crowns);
  // apple orchard rows on the slope to the north (not on a road out of town)
  const orchard: Pt[] = [];
  for (let row = 0; row < 26; row++)
    for (let x = requireValue(orchardX[0]) + (row % 2) * 1.6; x < requireValue(orchardX[1]); x += 3.2)
      if (!onRoad(x, orchardZ - row * 4, 2)) orchard.push([x, orchardZ - row * 4]);
  const apples = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    plain(0x3f6e2c, 0.95),
    orchard.length,
  );
  orchard.forEach(([x, z], i) => {
    dummy.position.set(x, groundAt(x, z) + 1.4, z);
    dummy.rotation.set(0, rand(0, 3), 0);
    dummy.scale.set(1.1, 1.3, 1.1);
    dummy.updateMatrix();
    apples.setMatrixAt(i, dummy.matrix);
  });
  root.add(apples);
  // the roads out of town, following the lie of the land
  const roadTex = canvasTexture(64, 128, (g, w: number, h: number) => {
    g.fillStyle = '#9c9b96';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#606367';
    g.fillRect(13, 0, 38, h);
    g.fillStyle = '#c9c7c0';
    g.fillRect(12, 0, 2, h);
    g.fillRect(50, 0, 2, h);
    g.fillStyle = 'rgba(232,196,64,0.9)';
    g.fillRect(31, 0, 2, h / 2);
  });
  roadTex.wrapS = THREE.ClampToEdgeWrapping;
  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTex,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  for (const e of exits) {
    const [dx, dz] = e.dir,
      rx = -dz,
      rz = dx,
      n = 60,
      len = 240,
      pos = [],
      uv = [],
      idx = [];
    for (let k = 0; k <= n; k++) {
      const t = (len * k) / n,
        x = e.x + dx * t,
        z = e.z + dz * t,
        y = Math.max(0.03, groundAt(x, z) + 0.34);
      pos.push(
        x - rx * (LANE + PAVE),
        y,
        z - rz * (LANE + PAVE),
        x + rx * (LANE + PAVE),
        y,
        z + rz * (LANE + PAVE),
      );
      uv.push(0, t / 6, 1, t / 6);
      if (k) {
        const o = (k - 1) * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, roadMat);
    road.receiveShadow = true;
    root.add(road);
  }
  const solid: [number, number, number][] = [];
  const clear = (x: number, z: number, r: number, m = 0) =>
    polyQuery(x, z).d > r + 22 &&
    !onRoad(x, z, r + 2) &&
    !inOrchard(x, z, r) &&
    solid.every((q) => Math.hypot(q[0] - x, q[1] - z) > q[2] + r + m);
  // houses and farms round about: white and red walls, dark or red roofs
  const houses: [number, number, number, boolean][] = [];
  for (let t = 0; t < 600 && houses.length < 24; t++) {
    const barn = houses.length < 3,
      x = rr(xa - 150, xb + 150),
      z = rr(za - 170, zb + 110),
      r = barn ? 10 : 7;
    if (!clear(x, z, r + 20, 8)) continue;
    houses.push([x, z, rr(0, Math.PI), barn]);
    solid.push([x, z, r]);
  }
  const wallG = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roofG = new THREE.CylinderGeometry(0.62, 0.62, 1, 3, 1)
    .rotateZ(Math.PI / 2)
    .rotateX(Math.PI / 2)
    .scale(1, 0.5, 1)
    .translate(0, 1.15, 0);
  const walls = new THREE.InstancedMesh(wallG, plain(0xffffff, 0.8), houses.length);
  const roofs = new THREE.InstancedMesh(roofG, plain(0xffffff, 0.8), houses.length);
  houses.forEach(([x, z, yaw, barn], i) => {
    const w = barn ? 16 : rand(8, 11),
      d = barn ? 10 : rand(6.5, 8),
      h = barn ? 7 : 5.5;
    dummy.position.set(x, lowest(x, z, w / 2) - 0.3, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
    walls.setColorAt(i, col.set(barn ? 0x9b2b22 : pick([0xf1efe8, 0xf1efe8, 0xe9e2c8, 0xa83a2c])));
    dummy.scale.set(w * 1.05, h * 0.55, d * 1.15);
    dummy.position.y += h * 0.45;
    dummy.updateMatrix();
    roofs.setMatrixAt(i, dummy.matrix);
    roofs.setColorAt(i, col.set(pick([0x3a3d42, 0x8e3426, 0x2e3033])));
  });
  walls.castShadow = roofs.castShadow = true;
  root.add(walls, roofs);
  // a few big soft clouds
  const cloudTex = canvasTexture(256, 128, (g, w: number, h: number) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 22; i++) {
      const x = rand(40, w - 40),
        y = rand(50, h - 30),
        r = rand(18, 42);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  cloudTex.wrapS = cloudTex.wrapT = THREE.ClampToEdgeWrapping;
  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTex,
    fog: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.92,
  });
  for (let i = 0; i < 16; i++) {
    const a = rand(0, TAU),
      d = rand(900, 2600);
    const s = new THREE.Sprite(cloudMat);
    s.position.set(Math.cos(a) * d, rand(500, 1000), Math.sin(a) * d);
    s.scale.set(rand(700, 1300), rand(250, 420), 1);
    root.add(s);
  }
}
