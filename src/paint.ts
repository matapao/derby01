import { drawPaintLayer, fadeCameraPaint, paintViewSurface } from './paint-view.ts';
import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import type { LocalHuman } from './human-types.ts';
import { requireFields } from './required-fields.ts';
import type { DamageZone } from './gameplay/geometry.ts';
import type { DamageCause } from './gameplay/model.ts';
import { canvasContext } from './browser-dom.ts';
import * as THREE from 'three';
import { ATLAS, GLASS, SHARED, TAU, TEAMS, _q1, _v1, _v2, _v3, clamp, pick, rand } from './core.ts';
import { scene } from './world.ts';
import { G } from './state.ts';
import { SMOKE } from './fx.ts';
import { SFX } from './audio.ts';
import { FX, share } from './net/effects.ts';

// =====================================================================
//  Paint: splat stamps, splats on the ground and walls, paint on the cars,
//  the wiped windshield and paint on the turret camera lenses.
// =====================================================================
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const paintCss = (team: number) => requireValue(TEAMS[team]).ui;
export const cssRgb = (css: string): [number, number, number] => [
  parseInt(css.slice(1, 3), 16) / 255,
  parseInt(css.slice(3, 5), 16) / 255,
  parseInt(css.slice(5, 7), 16) / 255,
];

// ---------------------------------------------------------------------
//  Splat shapes: a lumpy blob, spikes, flung droplets and (for walls and glass) drips running down.
//  White on transparent, 128 px; the blob is ~41% of the square across.
// ---------------------------------------------------------------------
const STAMP_SIZE = 128,
  BLOB_FRAC = 0.41;
function makeStamp(seed: number, drips: boolean) {
  const R = seeded(seed),
    S = STAMP_SIZE;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = canvasContext(cv);
  const cx = S / 2,
    cy = drips ? S * 0.42 : S / 2,
    base = (S * BLOB_FRAC) / 2;
  g.fillStyle = '#fff';
  // main blob
  const N = 26,
    pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU,
      r = base * (0.8 + 0.28 * R());
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const p = requireValue(pts[i % N]),
      q = requireValue(pts[(i + 1) % N]),
      mx = (requireValue(p[0]) + requireValue(q[0])) / 2,
      my = (requireValue(p[1]) + requireValue(q[1])) / 2;
    if (i === 0) g.moveTo(mx, my);
    else g.quadraticCurveTo(requireValue(p[0]), requireValue(p[1]), mx, my);
  }
  g.fill();
  // spikes thrown out by the impact
  const spikes = 5 + Math.floor(R() * 6);
  for (let k = 0; k < spikes; k++) {
    const a = R() * TAU,
      len = base * (1.15 + R() * 0.85),
      w = base * (0.1 + R() * 0.13);
    const ex = cx + Math.cos(a) * len,
      ey = cy + Math.sin(a) * len,
      nx = -Math.sin(a),
      ny = Math.cos(a);
    g.beginPath();
    g.moveTo(cx + nx * w * 1.6, cy + ny * w * 1.6);
    g.lineTo(ex + nx * w * 0.35, ey + ny * w * 0.35);
    g.lineTo(ex - nx * w * 0.35, ey - ny * w * 0.35);
    g.lineTo(cx - nx * w * 1.6, cy - ny * w * 1.6);
    g.fill();
    g.beginPath();
    g.arc(ex, ey, w * 0.62, 0, TAU);
    g.fill();
  }
  // droplets
  const drops = 6 + Math.floor(R() * 10);
  for (let k = 0; k < drops; k++) {
    const a = R() * TAU,
      d = base * (1.3 + R() * 1.0),
      r = base * (0.05 + R() * 0.13);
    g.beginPath();
    g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, TAU);
    g.fill();
  }
  // drips running down
  if (drips) {
    const n = 2 + Math.floor(R() * 3);
    for (let k = 0; k < n; k++) {
      const x = cx + (R() - 0.5) * base * 1.5,
        w = 2.5 + R() * 4,
        top = cy + base * 0.3,
        len = Math.min(S - 8 - top, base * (0.7 + R() * 1.6));
      g.beginPath();
      g.roundRect(x - w / 2, top, w, len, w / 2);
      g.fill();
      g.beginPath();
      g.arc(x, top + len, w * 0.85, 0, TAU);
      g.fill();
    }
  }
  return cv;
}
const STAMPS = {
  flat: [11, 23, 37, 51].map((s) => makeStamp(s, false)),
  drip: [61, 73, 89, 97].map((s) => makeStamp(s, true)),
};

// A stamp painted in one colour, glossy in the middle and a touch darker at the rim.
const tintCache = new Map<string, HTMLCanvasElement>();
function tintedStamp(kind: keyof typeof STAMPS, i: number, css: string) {
  const key = kind + i + css;
  let cv = tintCache.get(key);
  if (cv) return cv;
  const src = requireValue(STAMPS[kind][i]);
  cv = document.createElement('canvas');
  cv.width = cv.height = STAMP_SIZE;
  const g = canvasContext(cv);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = css;
  g.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);
  g.globalCompositeOperation = 'source-atop';
  const cx = STAMP_SIZE / 2 - 8,
    cy = (kind === 'drip' ? STAMP_SIZE * 0.42 : STAMP_SIZE / 2) - 9;
  const grd = g.createRadialGradient(cx, cy, 2, cx + 8, cy + 9, STAMP_SIZE * 0.45);
  grd.addColorStop(0, 'rgba(255,255,255,0.38)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.06)');
  grd.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = grd;
  g.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);
  tintCache.set(key, cv);
  return cv;
}
// White version with baked shading, for the instanced decals (tinted per instance).
function shadedWhite(kind: keyof typeof STAMPS, i: number) {
  return tintedStamp(kind, i, '#ffffff');
}

// ---------------------------------------------------------------------
//  Splats on the ground, roofs and walls: pools of instanced quads that grow in with a "splot"
// ---------------------------------------------------------------------
type DecalSet = { m: THREE.InstancedMesh; next: number };
class DecalPool {
  cap: number;
  sets: DecalSet[];
  grow: { s: DecalSet; i: number; pos: THREE.Vector3; quat: THREE.Quaternion; size: number; t: number }[] =
    [];
  constructor(kind: keyof typeof STAMPS, cap: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cap = cap;
    this.sets = STAMPS[kind].map((_, i: number) => {
      const tex = new THREE.CanvasTexture(shadedWhite(kind, i));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        roughness: 0.28,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      });
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.renderOrder = 1;
      scene.add(m);
      return { m, next: 0 };
    });
    this.clear();
  }
  clear() {
    _m4.makeScale(0, 0, 0);
    for (const s of this.sets) {
      for (let i = 0; i < this.cap; i++) s.m.setMatrixAt(i, _m4);
      s.m.instanceMatrix.needsUpdate = true;
      s.next = 0;
    }
    this.grow.length = 0;
  }
  add(pos: THREE.Vector3, quat: THREE.Quaternion, size: number, color: THREE.Color) {
    const s = pick(this.sets),
      i = s.next;
    s.next = (i + 1) % this.cap;
    s.m.setColorAt(i, color);
    if (s.m.instanceColor) s.m.instanceColor.needsUpdate = true;
    this.grow.push({ s, i, pos: pos.clone(), quat: quat.clone(), size, t: 0 });
  }
  update(dt: number) {
    for (let k = this.grow.length - 1; k >= 0; k--) {
      const d = requireValue(this.grow[k]);
      d.t += dt;
      const f = Math.min(1, d.t / 0.09),
        e = 1 - (1 - f) * (1 - f);
      const sc = d.size * (0.3 + 0.7 * e);
      _sc.set(sc, sc, 1);
      _m4.compose(d.pos, d.quat, _sc);
      d.s.m.setMatrixAt(d.i, _m4);
      d.s.m.instanceMatrix.needsUpdate = true;
      if (f >= 1) this.grow.splice(k, 1);
    }
  }
}
const _m4 = new THREE.Matrix4(),
  _sc = new THREE.Vector3(),
  _pq2 = new THREE.Quaternion(),
  _pc = new THREE.Color();
const _bx = new THREE.Vector3(),
  _by = new THREE.Vector3(),
  _bz = new THREE.Vector3(),
  _bm = new THREE.Matrix4();
const FLAT_DECALS = new DecalPool('flat', 220);
const WALL_DECALS = new DecalPool('drip', 110);

// size = width of the splat square in metres
export function groundSplat(p: { x: number; z: number }, size: number, css: string, y = 0.03) {
  if (share(FX.groundSplat, groundSplat, [p, size, css, y])) return;
  _pq2
    .setFromAxisAngle(_v1.set(0, 1, 0), rand(0, TAU))
    .multiply(_q1.setFromAxisAngle(_v2.set(1, 0, 0), -Math.PI / 2));
  FLAT_DECALS.add(_v3.set(p.x, y, p.z), _pq2, size, _pc.set(css));
}
export function wallSplat(
  p: import('./gameplay/geometry.ts').Vector,
  n: import('./gameplay/geometry.ts').Vector,
  size: number,
  css: string,
) {
  if (share(FX.wallSplat, wallSplat, [p, n, size, css])) return;
  if (Math.abs(n.y) > 0.8) {
    groundSplat(p, size, css, p.y + 0.02);
    return;
  } // a roof
  _bz.copy(n).normalize();
  _by.set(0, 1, 0).addScaledVector(_bz, -_bz.y).normalize(); // texture "down" runs down the wall
  _bx.crossVectors(_by, _bz);
  _pq2.setFromRotationMatrix(_bm.makeBasis(_bx, _by, _bz));
  WALL_DECALS.add(_v3.copy(p).addScaledVector(_bz, 0.03), _pq2, size, _pc.set(css));
}

// ---------------------------------------------------------------------
//  Impact effects: droplets, a burst of mist and a wet splat sound
// ---------------------------------------------------------------------
let splatSounds = 0;
export function paintImpact(
  p: import('./gameplay/geometry.ts').Vector,
  n: import('./gameplay/geometry.ts').Vector,
  vin: (import('./gameplay/geometry.ts').Vector & { length(): number }) | null,
  css: string,
  strength = 1,
) {
  if (share(FX.paintImpact, paintImpact, [p, n, vin, css, strength])) return;
  const [r, g, b] = cssRgb(css);
  const sp = vin ? Math.min(1, vin.length() / 80) : 1;
  const count = Math.round((9 + Math.random() * 6) * strength);
  for (let i = 0; i < count; i++) {
    const out = rand(1.5, 5.5) * strength;
    SMOKE.emit({
      x: p.x + n.x * 0.04,
      y: p.y + n.y * 0.04,
      z: p.z + n.z * 0.04,
      vx: n.x * out + rand(-3, 3) * strength + (vin ? vin.x * 0.04 * sp : 0),
      vy: n.y * out + rand(0.5, 3.5) * strength,
      vz: n.z * out + rand(-3, 3) * strength + (vin ? vin.z * 0.04 * sp : 0),
      life: rand(0.35, 0.7),
      s0: rand(0.06, 0.13) * Math.sqrt(strength),
      s1: 0.04,
      c0: [r, g, b, 1],
      c1: [r * 0.85, g * 0.85, b * 0.85, 0.9],
      grav: 14,
      drag: 1.2,
    });
  }
  // the puff of paint mist right at the impact
  SMOKE.emit({
    x: p.x + n.x * 0.06,
    y: p.y + n.y * 0.06,
    z: p.z + n.z * 0.06,
    life: 0.2,
    s0: 0.25 * strength,
    s1: 1.15 * strength,
    c0: [r, g, b, 0.75],
    c1: [r, g, b, 0],
  });
  if (splatSounds < 5) {
    splatSounds++;
    SFX.splat(p, strength);
  }
}

// A paint bomb when a car is out. Big splats all round on the ground.
export function paintBurst(x: number, y: number, z: number, css: string, big = false) {
  if (share(FX.paintBurst, paintBurst, [x, y, z, css, big])) return;
  const n = _v1.set(0, 1, 0);
  paintImpact(_v2.set(x, y, z), n, null, css, big ? 2.6 : 2);
  const [r, g, b] = cssRgb(css);
  for (let i = 0; i < (big ? 70 : 45); i++) {
    const a = rand(0, TAU),
      sp = rand(3, big ? 13 : 10);
    SMOKE.emit({
      x,
      y: y + 0.3,
      z,
      vx: Math.cos(a) * sp,
      vy: rand(2, 9),
      vz: Math.sin(a) * sp,
      life: rand(0.5, 1.1),
      s0: rand(0.12, 0.3),
      s1: 0.06,
      c0: [r, g, b, 1],
      c1: [r, g, b, 0.85],
      grav: 14,
      drag: 0.8,
    });
  }
  groundSplat({ x, z }, big ? 6.5 : 5, css);
  for (let i = 0; i < (big ? 10 : 7); i++) {
    const a = rand(0, TAU),
      d = rand(1.2, big ? 5.5 : 4);
    groundSplat({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d }, rand(1.4, 3), css);
  }
  SFX.splat(_v2.set(x, y, z), 3);
}

// ---------------------------------------------------------------------
//  Paint on the cars: one canvas atlas per car. The car is seen from the left, right,
//  top, front and back (88 px per metre); the car shader looks up the view that faces
//  the same way as the surface. See ATLAS in the core section.
// ---------------------------------------------------------------------
function paintAtlasAt(
  car: Car,
  l: import('./gameplay/geometry.ts').Vector,
  axis: number,
  sign: number,
  sizeM: number,
  css: string,
) {
  const A = ATLAS;
  let reg, u, v;
  let kind: keyof typeof STAMPS;
  if (axis === 0) {
    reg = sign > 0 ? A.L : A.R;
    u = (l.z - A.ZMIN) * A.PX;
    v = (A.YMAX - l.y) * A.PX;
    kind = 'drip';
  } else if (axis === 1) {
    if (sign < 0) return;
    reg = A.T;
    u = (l.z - A.ZMIN) * A.PX;
    v = (l.x - A.XMIN) * A.PX;
    kind = 'flat';
  } else {
    reg = sign > 0 ? A.F : A.B;
    u = (l.x - A.XMIN) * A.PX;
    v = (A.YMAX - l.y) * A.PX;
    kind = 'drip';
  }
  const g = car.atlas.g,
    s = (sizeM / BLOB_FRAC) * A.PX;
  g.save();
  g.beginPath();
  g.rect(requireValue(reg[0]), requireValue(reg[1]), requireValue(reg[2]), requireValue(reg[3]));
  g.clip();
  g.translate(requireValue(reg[0]) + u, requireValue(reg[1]) + v);
  g.rotate(kind === 'drip' ? rand(-0.25, 0.25) : rand(0, TAU));
  g.drawImage(
    tintedStamp(kind, (Math.random() * 4) | 0, css),
    -s / 2,
    -s * (kind === 'drip' ? 0.42 : 0.5),
    s,
    s,
  );
  g.restore();
  car.atlas.dirty = true;
}

// A paintball hit a car at l (car space) on box face (axis, sign).
export function paintHitCar(
  car: Car,
  l: import('./gameplay/geometry.ts').Vector,
  axis: number,
  sign: number,
  css: string,
) {
  if (share(FX.paintHitCar, paintHitCar, [car, l, axis, sign, css])) return;
  paintAtlasAt(car, l, axis, sign, rand(0.3, 0.46), css);
  const GL = car.glass;
  // windshield: hits on the front above the hood line, or on top between the roof and the hood
  if ((axis === 2 && sign > 0 && l.y > 0.86) || (axis === 1 && sign > 0 && l.z > 0.3 && l.z < 1.2)) {
    const u = clamp((0.76 - l.x) / 1.52, 0.06, 0.94);
    const v = axis === 2 ? clamp((1.45 - l.y) / 0.52, 0.08, 0.92) : clamp((l.z - 0.45) / 0.55, 0.08, 0.92);
    GL.shield.splat(u, v, rand(78, 118), css);
    if (Math.random() < 0.55) crackWindshield(car, u, v, rand(0.7, 1.2));
  } else if (axis === 1 && sign > 0 && l.z >= 1.2)
    GL.shield.spray(rand(4, 9) | 0, css); // hood hits spatter up the glass
  else if (axis === 2 && sign > 0) GL.shield.spray(3, css);
  // side and rear windows crack where the ball lands
  if (Math.random() < 0.5 && (axis === 0 || (axis === 2 && sign < 0))) crackGlassAt(car, l, rand(0.6, 1.1));
  // the little cameras on the turrets
  const dh = Math.hypot(l.x, l.y - 1.15, l.z - 1.45),
    dtk = Math.hypot(l.x, l.y - 1.05, l.z + 1.72);
  if (dh < 0.95)
    GL.hood.splat(clamp(0.5 - l.x * 0.45 + rand(-0.2, 0.2), 0.1, 0.9), rand(0.15, 0.7), rand(80, 125), css);
  else if (dh < 1.9) GL.hood.spray(4, css);
  if (dtk < 0.95)
    GL.trunk.splat(clamp(0.5 + l.x * 0.45 + rand(-0.2, 0.2), 0.1, 0.9), rand(0.15, 0.7), rand(80, 125), css);
  else if (dtk < 1.9) GL.trunk.spray(4, css);
}

// ---------------------------------------------------------------------
//  Wiped glass. Paint lands on a small canvas; the wipers sweep back and forth all the time,
//  thinning the paint a bit on every pass and leaving streaks.
// ---------------------------------------------------------------------
export class WipedGlass {
  w: number;
  h: number;
  area: number;
  cv: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  readonly surface: 'windshield' | 'camera';
  wipers: { x: number; y: number; len: number }[];
  period: number;
  a0: number;
  a1: number;
  phase: number;
  ang: number;
  cover: number;
  dirty: boolean;
  up: number;
  tex: THREE.CanvasTexture | null = null; // the windshield's: on its glass in 3D (initCarPaint)
  crack: {
    cv: HTMLCanvasElement;
    g: CanvasRenderingContext2D;
    tex: THREE.CanvasTexture;
    level: number;
    shattered: boolean;
    dirty: boolean;
    up: number;
  } | null = null; // the windshield's cracks
  // wipers: [{ x, y, len }] in canvas pixels; angles a0..a1 in radians (0 = blade lying to the left)
  constructor(
    w: number,
    h: number,
    wipers: WipedGlass['wipers'],
    period: number,
    a0: number,
    a1: number,
    surface: 'windshield' | 'camera' = 'windshield',
  ) {
    this.surface = surface;
    this.area = w * h;
    this.cv = document.createElement('canvas');
    this.cv.width = w;
    this.cv.height = h;
    this.g = canvasContext(this.cv);
    this.w = w;
    this.h = h;
    this.wipers = surface === 'camera' ? [] : wipers;
    this.period = period;
    this.a0 = a0;
    this.a1 = a1;
    this.phase = rand(0, TAU);
    this.ang = (a0 + a1) / 2;
    this.cover = 0;
    this.dirty = true;
    this.up = 0;
  }
  // u, v in 0..1; size = width of the blob in canvas pixels
  splat(u: number, v: number, size: number, css: string) {
    const s = size / BLOB_FRAC,
      g = this.g;
    g.save();
    g.translate(u * this.w, v * this.h);
    g.rotate(rand(-0.3, 0.3));
    g.drawImage(tintedStamp('drip', (Math.random() * 4) | 0, css), -s / 2, -s * 0.42, s, s);
    g.restore();
    this.cover = 1 - (1 - this.cover) * (1 - Math.min(0.85, (size * size * 1.1) / this.area));
    this.dirty = true;
  }
  spray(n: number, css: string) {
    const g = this.g;
    g.fillStyle = css;
    for (let i = 0; i < n; i++) {
      const x = rand(0, this.w),
        y = rand(0, this.h),
        r = rand(1.5, 6);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      if (r > 3.5) {
        g.beginPath();
        g.roundRect(x - r * 0.35, y, r * 0.7, rand(4, 16), r * 0.35);
        g.fill();
      } // a drip
    }
    this.cover = Math.min(1, this.cover + n * 0.004);
    this.dirty = true;
  }
  update(dt: number) {
    if (this.surface === 'camera') {
      const cover = fadeCameraPaint(this.g, this.w, this.h, this.cover, dt);
      if (cover !== this.cover) this.dirty = true;
      this.cover = cover;
      return;
    }
    const prev = this.ang;
    this.phase += (dt * TAU) / this.period;
    const s = Math.sin(this.phase),
      mid = (this.a0 + this.a1) / 2,
      amp = (this.a1 - this.a0) / 2;
    this.ang = mid + amp * Math.sign(s) * Math.pow(Math.abs(s), 0.65); // lingers a moment at each end, like real wipers
    if (this.cover < 0.003) {
      this.cover = 0;
      return;
    }
    const lo = Math.min(prev, this.ang) + Math.PI,
      hi = Math.max(prev, this.ang) + Math.PI;
    if (hi - lo < 1e-4) return;
    const g = this.g;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    let area = 0;
    for (const wp of this.wipers) {
      const r0 = wp.len * 0.12;
      g.beginPath();
      g.arc(wp.x, wp.y, wp.len, lo, hi);
      g.arc(wp.x, wp.y, r0, hi, lo, true);
      g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fill();
      // the rubber wipes cleaner in some bands: streaks
      g.beginPath();
      for (let r = r0 + 5; r < wp.len - 4; r += 10) {
        g.moveTo(wp.x + Math.cos(lo) * (r + 5), wp.y + Math.sin(lo) * (r + 5));
        g.arc(wp.x, wp.y, r + 5, lo, hi);
        g.arc(wp.x, wp.y, r, hi, lo, true);
        g.closePath();
      }
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.fill();
      area += 0.5 * (wp.len * wp.len - r0 * r0) * (hi - lo);
    }
    g.restore();
    this.cover *= 1 - 0.33 * Math.min(1, (area * 0.62) / (this.w * this.h));
    this.dirty = true;
  }
}

// Windshield glass frame (from the model): bottom edge, up-the-glass and outward directions.
const SHIELD_W = 1.52;
export function initCarPaint(car: Pick<Car, 'body' | 'paint' | 'rubberMat' | 'trimMat' | 'glassMat'>) {
  const A = ATLAS;
  const atlas = () => {
    const cv = document.createElement('canvas');
    cv.width = A.W;
    cv.height = A.H;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { cv, g: canvasContext(cv), tex, dirty: false, up: 0 };
  };
  const paintAtlas = atlas(); // paint
  const cracks = atlas(); // cracks in the side and rear windows
  for (const m of [car.paint, car.rubberMat, car.trimMat, car.glassMat])
    m.userData['u'].paintAtlas.value = paintAtlas.tex;
  car.glassMat.userData['u'].crackAtlas.value = cracks.tex;

  const glass = {
    // the windshield's wipers work in tandem, from lying along the bottom up towards the driver's pillar, and
    // stay on the glass (a trapezoid: 448 px across the bottom, 360 across the top, 208 high)
    shield: new WipedGlass(
      448,
      208,
      [
        { x: 90, y: 214, len: 190 },
        { x: 270, y: 214, len: 170 },
      ],
      1.3,
      1.3,
      3.0,
    ),
    hood: new WipedGlass(320, 180, [], 1, 0, 0, 'camera'),
    trunk: new WipedGlass(320, 180, [], 1, 0, 0, 'camera'),
  };
  // windshield cracks: their own canvas (the wipers can't wipe those)
  const sh = glass.shield;
  const crackCv = document.createElement('canvas');
  crackCv.width = sh.w;
  crackCv.height = sh.h;
  const crackTex = new THREE.CanvasTexture(crackCv);
  crackTex.colorSpace = THREE.SRGBColorSpace;
  crackTex.magFilter = THREE.LinearFilter;
  crackTex.minFilter = THREE.LinearFilter;
  crackTex.generateMipmaps = false;
  sh.crack = {
    cv: crackCv,
    g: canvasContext(crackCv),
    tex: crackTex,
    level: 0,
    shattered: false,
    dirty: false,
    up: 0,
  };

  // the windshield in 3D: crack film in the glass, wipers on it, paint film on the outside
  const f = GLASS.shield;
  sh.tex = new THREE.CanvasTexture(sh.cv);
  sh.tex.colorSpace = THREE.SRGBColorSpace;
  sh.tex.magFilter = THREE.LinearFilter;
  sh.tex.minFilter = THREE.LinearFilter;
  sh.tex.generateMipmaps = false;
  const layer = new THREE.Group();
  const s = f.len / 2;
  layer.position.set(0, f.y + f.uy * s, f.z + f.uz * s); // the inner face of the glass
  // local x = to the driver's right, local y = up the glass, local z = in towards the driver
  layer.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, f.uy, f.uz),
      new THREE.Vector3(0, -f.ny, -f.nz),
    ),
  );
  const crackFilm = new THREE.Mesh(
    SHIELD_GEO,
    new THREE.MeshBasicMaterial({
      map: sh.crack.tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  crackFilm.position.z = -0.014; // inside the glass
  crackFilm.renderOrder = 2;
  const film = new THREE.Mesh(
    SHIELD_GEO,
    new THREE.MeshStandardMaterial({
      map: sh.tex,
      transparent: true,
      depthWrite: false,
      roughness: 0.25,
      side: THREE.DoubleSide,
    }),
  );
  film.position.z = -0.038; // on the outside
  film.renderOrder = 3;
  layer.add(crackFilm, film);
  const k = SHIELD_W / sh.w; // metres per canvas pixel
  const wiperArms = sh.wipers.map((wp) => {
    const arm = new THREE.Mesh(WIPER_GEO, SHARED.darkMetal);
    arm.position.set((wp.x / sh.w - 0.5) * SHIELD_W, (0.5 - wp.y / sh.h) * f.len, -0.032); // on the glass, under the paint
    arm.scale.x = wp.len * k;
    layer.add(arm);
    return arm;
  });
  car.body.add(layer);
  requireFields(sh, ['tex', 'crack']);
  return {
    atlas: paintAtlas,
    cracks,
    glass: { ...glass, shield: sh },
    wiperArms,
    shieldFilm: film,
    crackFilm,
  };
}
const WIPER_GEO = new THREE.BoxGeometry(1, 0.016, 0.012).translate(0.5, 0, 0);
// The windshield is a trapezoid: 1.52 m across the bottom, 1.22 m across the top.
const SHIELD_GEO = (() => {
  const L = GLASS.shield.len,
    B = SHIELD_W / 2,
    T = 0.61;
  const g = new THREE.BufferGeometry();
  const pos = [-B, -L / 2, 0, B, -L / 2, 0, T, L / 2, 0, -T, L / 2, 0];
  const uv = [];
  for (let i = 0; i < pos.length; i += 3)
    uv.push((requireValue(pos[i]) + B) / SHIELD_W, (requireValue(pos[i + 1]) + L / 2) / L);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
})();

// ---------------------------------------------------------------------
//  Cracks: a spider web of lines from the point of impact
// ---------------------------------------------------------------------
function drawCrackWeb(g: CanvasRenderingContext2D, x: number, y: number, size: number, lw = 1.3) {
  const arms = 5 + ((Math.random() * 5) | 0);
  const paths: [number, number][][] = [];
  for (let i = 0; i < arms; i++) {
    let a = (i / arms) * TAU + rand(-0.3, 0.3),
      px = x,
      py = y;
    const len = size * rand(0.5, 1),
      segs = 4 + ((Math.random() * 4) | 0),
      path: [number, number][] = [[x, y]];
    for (let k = 0; k < segs; k++) {
      a += rand(-0.35, 0.35);
      px += (Math.cos(a) * len) / segs;
      py += (Math.sin(a) * len) / segs;
      path.push([px, py]);
    }
    paths.push(path);
  }
  const rings: [number, number][][] = [];
  for (const f of [0.28, 0.55, 0.8].slice(0, 1 + ((Math.random() * 3) | 0))) {
    const ring = paths
      .map((p) => requireValue(p[Math.round(f * (p.length - 1))]))
      .map(([qx, qy]): [number, number] => [qx + rand(-1.5, 1.5), qy + rand(-1.5, 1.5)]);
    ring.push(requireValue(ring[0]));
    rings.push(ring);
  }
  const stroke = (w: number, col: string) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    for (const p of [...paths, ...rings]) {
      g.moveTo(requireValue(requireValue(p[0])[0]), requireValue(requireValue(p[0])[1]));
      for (let i = 1; i < p.length; i++)
        g.lineTo(requireValue(requireValue(p[i])[0]), requireValue(requireValue(p[i])[1]));
    }
    g.stroke();
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  stroke(lw * 2.2, 'rgba(0,0,0,0.25)');
  stroke(lw, 'rgba(236,244,250,0.92)');
  g.fillStyle = 'rgba(240,248,255,0.85)';
  g.beginPath();
  g.arc(x, y, size * 0.07, 0, TAU);
  g.fill();
}

// Crack the windshield at (u, v), 0..1. strength ~1 for a paintball, more for crashes.
export function crackWindshield(car: Car, u: number, v: number, strength = 1) {
  if (share(FX.crackWindshield, crackWindshield, [car, u, v, strength])) return;
  const C = car.glass.shield.crack,
    g = C.g,
    w = car.glass.shield.w,
    h = car.glass.shield.h;
  drawCrackWeb(g, u * w, v * h, 34 + strength * 30, 1.1 + strength * 0.25);
  C.level = Math.min(1.2, C.level + 0.07 * strength);
  if (C.level > 0.55) {
    g.fillStyle = `rgba(222,232,238,${0.05 * strength})`;
    g.fillRect(0, 0, w, h);
  } // going milky
  if (C.level >= 1 && !C.shattered) {
    C.shattered = true; // crazed all over
    for (let i = 0; i < 14; i++)
      drawCrackWeb(g, rand(0.05, 0.95) * w, rand(0.05, 0.95) * h, rand(50, 110), 1.2);
    g.fillStyle = 'rgba(222,232,238,0.25)';
    g.fillRect(0, 0, w, h);
  }
  C.dirty = true;
  if (G.humans.some((hm) => hm.car === car)) SFX.crack(car.pos, strength);
}
export function clearWindshieldCracks(car: Car) {
  const C = car.glass.shield.crack;
  C.g.clearRect(0, 0, C.cv.width, C.cv.height);
  C.level = 0;
  C.shattered = false;
  C.dirty = true;
}

// Crack a side or rear window (atlas view `reg` at atlas pixel u, v).
function crackWindowAt(car: Car, reg: number[], u: number, v: number, strength = 1) {
  const g = car.cracks.g;
  g.save();
  g.beginPath();
  g.rect(requireValue(reg[0]), requireValue(reg[1]), requireValue(reg[2]), requireValue(reg[3]));
  g.clip();
  drawCrackWeb(g, requireValue(reg[0]) + u, requireValue(reg[1]) + v, 14 + strength * 12, 0.9);
  g.restore();
  car.cracks.dirty = true;
}
// A spot in car space on a side window or the rear window: crack it there.
export function crackGlassAt(car: Car, l: { x: number; y: number; z: number }, strength: number) {
  if (share(FX.crackGlassAt, crackGlassAt, [car, l, strength])) return;
  const A = ATLAS;
  if (Math.abs(l.x) > 0.6 && l.y > 0.95 && l.y < 1.42 && l.z > -0.95 && l.z < 0.85) {
    crackWindowAt(car, l.x > 0 ? A.L : A.R, (l.z - A.ZMIN) * A.PX, (A.YMAX - l.y) * A.PX, strength);
  } else if (l.z < -0.75 && l.y > 0.9 && l.y < 1.43) {
    crackWindowAt(car, A.B, (clamp(l.x, -0.7, 0.7) - A.XMIN) * A.PX, (A.YMAX - l.y) * A.PX, strength);
  }
}

// Crashes: hard knocks crack the glass nearest the hit.
export function crackFromKnock(car: Car, zone: DamageZone | null, cause: DamageCause, dv: number) {
  if (share(FX.crackFromKnock, crackFromKnock, [car, zone, cause, dv])) return;
  if (dv < 5.5 || !car.alive) return;
  const s = Math.min(3, (dv - 4) / 3);
  if (zone === 'front') crackWindshield(car, rand(0.15, 0.85), rand(0.3, 0.9), s);
  if (zone === 'lf' || zone === 'lr')
    crackGlassAt(car, { x: 0.8, y: rand(1.0, 1.35), z: zone === 'lf' ? rand(0, 0.8) : rand(-0.9, -0.1) }, s);
  if (zone === 'rf' || zone === 'rr')
    crackGlassAt(car, { x: -0.8, y: rand(1.0, 1.35), z: zone === 'rf' ? rand(0, 0.8) : rand(-0.9, -0.1) }, s);
  if (zone === 'rear') crackGlassAt(car, { x: rand(-0.5, 0.5), y: rand(1.0, 1.35), z: -1.1 }, s);
}

export function disposeCarPaint(car: Car) {
  car.atlas.tex.dispose();
  car.cracks.tex.dispose();
  car.glass.shield.tex.dispose();
  car.glass.shield.crack.tex.dispose();
  car.shieldFilm.material.dispose();
  car.crackFilm.material.dispose();
}

// Every frame: grow new splats, run the wipers, send changed paint to the GPU.
export function updatePaint(dt: number, running: boolean) {
  splatSounds = 0;
  FLAT_DECALS.update(dt);
  WALL_DECALS.update(dt);
  const now = performance.now() / 1000;
  const cockpit = new Set(
    G.humans.filter((h) => h.seat === 0 && h.camMode === 'cockpit' && !h.dead).map((h) => h.car),
  );
  for (const car of G.cars) {
    if (running && car.alive) for (const glass of Object.values(car.glass)) glass.update(dt);
    const sh = car.glass.shield;
    for (const arm of car.wiperArms) arm.rotation.z = Math.PI - sh.ang;
    if (sh.dirty && now - sh.up > (cockpit.has(car) ? 0 : 0.1)) {
      sh.tex.needsUpdate = true;
      sh.dirty = false;
      sh.up = now;
    }
    for (const a of [car.atlas, car.cracks, sh.crack])
      if (a.dirty && now - a.up > 0.08) {
        a.tex.needsUpdate = true;
        a.dirty = false;
        a.up = now;
      }
  }
}
export function clearPaint() {
  FLAT_DECALS.clear();
  WALL_DECALS.clear();
}

// ---------------------------------------------------------------------
//  Flying paintballs: instanced glossy balls, a little stretched along their flight
// ---------------------------------------------------------------------
const BALL_MAX = 700;
const ballMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.06, 10, 8),
  new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0.05 }),
  BALL_MAX,
);
ballMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BALL_MAX * 3), 3);
ballMesh.frustumCulled = false;
ballMesh.count = 0;
scene.add(ballMesh);
export const _bd = new THREE.Vector3();
export function drawBalls() {
  let n = 0;
  for (const b of G.bullets) {
    if (n >= BALL_MAX) break;
    _bd.copy(b.v).normalize();
    _q1.setFromUnitVectors(_v1.set(0, 0, 1), _bd);
    _sc.set(1, 1, 1.7);
    _m4.compose(b.p, _q1, _sc);
    ballMesh.setMatrixAt(n, _m4);
    ballMesh.setColorAt(n, b.color3);
    n++;
  }
  ballMesh.count = n;
  ballMesh.instanceMatrix.needsUpdate = true;
  if (n && ballMesh.instanceColor) ballMesh.instanceColor.needsUpdate = true;
}

// Windshield effects belong to the driver; turret camera overlays contain paint only.
export function drawPaintOverlay(h: LocalHuman) {
  const u = h.hud;
  if (!u) return;
  const key = paintViewSurface(h.seat, h.camMode, !h.dead && h.car.alive);
  const context = u.paintCtx;
  const canvas = u.paint;
  if (!key) {
    if (u.last.paintOn) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      u.last.paintOn = false;
    }
    return;
  }
  u.last.paintOn = true;
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawPaintLayer(context, h.car.glass[key], canvas.width, canvas.height, key === 'shield');
}
