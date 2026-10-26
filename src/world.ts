import { requireValue } from './required-fields.ts';
import { createRenderQuality, renderDimensions, type RenderMode } from './render-quality.ts';
import type { Obstacle } from './town/colliders.ts';
import type { Pt } from './layout.ts';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as THREE from 'three';
import { TAU, clamp, rand, wrapPi } from './core.ts';
export interface RuntimeObstacle extends Obstacle {
  down?: boolean;
  br?: number;
  breakId?: number;
  brk?: import('./breakables.ts').Breakable;
}
export interface Ramp {
  x: number;
  z: number;
  s: number;
  c: number;
  hw: number;
  hl: number;
  h: number;
}
interface Surface {
  x0: number;
  z0: number;
  w: number;
  h: number;
  cell: number;
  grid: Uint8Array;
}

// =====================================================================
//  Renderer, scene, sky, light
//  Crisp CSS-resolution rendering with a bounded pixel budget for modest GPUs.
// =====================================================================
// Without WebGL 2 there's no game: the loading screen says so, and nothing else runs.
function makeRenderer(): THREE.WebGLRenderer {
  try {
    return new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: new URLSearchParams(location.search).has('test'),
    });
  } catch (err) {
    const note = document.getElementById('loading');
    if (note) {
      note.textContent =
        'derby01 needs WebGL 2. Try another browser, or turn on hardware acceleration in this one.';
      note.style.cssText = 'font: 600 20px var(--ui); text-align: center; padding: 24px;';
    }
    throw err;
  }
}
export const renderer = makeRenderer();
renderer.domElement.id = 'gl';
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.shadowMap.autoUpdate = false; // updated once per frame, not once per viewport
document.body.prepend(renderer.domElement);

const quality = createRenderQuality();
export function fitRenderer(): void {
  const size = renderDimensions(window.innerWidth, window.innerHeight, quality.budget);
  renderer.setPixelRatio(size.pixelRatio);
  renderer.setSize(size.width, size.height);
}
export function setRenderMode(mode: RenderMode): void {
  quality.setMode(mode);
  fitRenderer();
}
export function getRenderMode(): RenderMode {
  return quality.mode;
}
fitRenderer();
export function adaptQuality(dt: number, playing: boolean): void {
  if (quality.observe(dt, playing)) fitRenderer();
}

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbdd4ed, 150, 3800); // the sky's colour at the horizon
// Soft light all round (three.js's room), drawn on the GPU. After a lost GPU context three.js uploads
// everything again but this, so it's made again then (the old one went with the context).
function makeEnvironment(): void {
  const pmrem = new THREE.PMREMGenerator(renderer),
    room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
}
makeEnvironment();
scene.environmentIntensity = 0.3;
renderer.domElement.addEventListener('webglcontextrestored', makeEnvironment);

export const SUN_DIR = new THREE.Vector3(-0.5, 0.72, 0.45).normalize();
const SKY_U = {
  sunDir: { value: SUN_DIR },
  zen: { value: new THREE.Color(0.2, 0.42, 0.82) },
  mid: { value: new THREE.Color(0.45, 0.64, 0.9) },
  hor: { value: new THREE.Color(0.74, 0.83, 0.93) },
  glow: { value: new THREE.Color(1, 0.95, 0.85) },
};
{
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: SKY_U,
      vertexShader:
        'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec3 sunDir, zen, mid, hor, glow; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, h));
          c = mix(c, zen, smoothstep(0.22, 0.85, h));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += glow * (pow(s, 48.0) * 1.2 + pow(s, 6.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.onBeforeRender = (_r, _s, cam) => sky.position.copy(cam.position);
  scene.add(sky);
}
const hemi = new THREE.HemisphereLight(0xd4e6ff, 0x5c6a44, 0.85);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff6e8, 1.9);
sun.position.copy(SUN_DIR).multiplyScalar(140); // (buildArena aims it at the town and fits the shadow camera round it)
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 10;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);

export function canvasTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (!g) throw new Error('Canvas 2D is unavailable');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// =====================================================================
//  Arena state, filled in by buildArena()
// =====================================================================
export const OBSTACLES: RuntimeObstacle[] = []; // { kind: 'circle', x, z, r, h } | { kind: 'box', x, z, hw, hl, yaw, h } (town/colliders.ts makes them)
export const RAMPS: Ramp[] = []; // { x, z, s, c (sin and cos of its yaw), hw, hl, h }: wedges that rise along their yaw
export let BOUNDS: { pts: Pt[]; en: Pt[]; wallH: number } = { pts: [], en: [], wallH: 0 }; // { pts, en (outward edge normals), wallH }
export let NAV: ReturnType<typeof buildNav> = { nodes: [], D: [], next: [] }; // waypoint graph so bots can find their way round the buildings
export let SURFACE: Surface = { x0: 0, z0: 0, w: 0, h: 0, cell: 1, grid: new Uint8Array() }; // grid of paved (1) / grass (0) cells; grass has less grip

// Edge of the arena: signed distance (negative inside) and outward normal of the nearest edge.
const _pq = { d: 0, nx: 0, nz: 0 };
export function polyQuery(x: number, z: number) {
  const P = BOUNDS.pts;
  let best = Infinity,
    inside = false,
    bx = 0,
    bz = 0,
    ei = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const ax = requireValue(P[j])[0],
      az = requireValue(P[j])[1],
      cx = requireValue(P[i])[0],
      cz = requireValue(P[i])[1];
    if (az > z !== cz > z && x < ((cx - ax) * (z - az)) / (cz - az) + ax) inside = !inside;
    const ex = cx - ax,
      ez = cz - az,
      l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1) : 0;
    const qx = ax + ex * t,
      qz = az + ez * t,
      d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d < best) {
      best = d;
      bx = qx;
      bz = qz;
      ei = i;
    }
  }
  const d = Math.sqrt(best);
  if (d > 1e-5) {
    const k = (inside ? -1 : 1) / d;
    _pq.nx = (x - bx) * k;
    _pq.nz = (z - bz) * k;
  } else {
    _pq.nx = requireValue(BOUNDS.en[ei])[0];
    _pq.nz = requireValue(BOUNDS.en[ei])[1];
  }
  _pq.d = inside ? -d : d;
  return _pq;
}
export function setBounds(pts: Pt[], wallH: number) {
  const en = pts.map((p, i: number): Pt => {
    const q = requireValue(pts[(i + pts.length - 1) % pts.length]);
    const ex = p[0] - q[0],
      ez = p[1] - q[1],
      l = Math.hypot(ex, ez) || 1;
    return [ez / l, -ex / l];
  });
  BOUNDS = { pts, en, wallH };
  // make every edge normal point outwards
  en.forEach((n, i: number) => {
    const p = requireValue(pts[i]),
      q = requireValue(pts[(i + pts.length - 1) % pts.length]);
    if (polyQuery((p[0] + q[0]) / 2 + n[0] * 0.05, (p[1] + q[1]) / 2 + n[1] * 0.05).d < 0) {
      n[0] = -n[0];
      n[1] = -n[1];
    }
  });
}
// Signed distance to the arena edge: > 0 means outside / into the wall.
export function arenaSDF(x: number, z: number) {
  return polyQuery(x, z).d;
}
// Outward normal of the edge nearest to (x, z).
export function arenaNormal(x: number, z: number, out: THREE.Vector3) {
  const q = polyQuery(x, z);
  return out.set(q.nx, 0, q.nz);
}

// How high the ground is: the town is flat but for its ramps, which rise from nothing at their near
// end to h at the far one.
export function groundHeight(x: number, z: number): number {
  let y = 0;
  for (const r of RAMPS) {
    const dx = x - r.x,
      dz = z - r.z,
      lx = dx * r.c - dz * r.s,
      lz = dx * r.s + dz * r.c;
    if (lx > -r.hw && lx < r.hw && lz > -r.hl && lz < r.hl) y = Math.max(y, (r.h * (lz + r.hl)) / (2 * r.hl));
  }
  return y;
}

// Grass is slower and slidier than tarmac.
export function surfaceGrip(x: number, z: number) {
  const S = SURFACE;
  const i = Math.floor((x - S.x0) / S.cell),
    j = Math.floor((z - S.z0) / S.cell);
  if (i < 0 || j < 0 || i >= S.w || j >= S.h) return 0.78;
  return S.grid[j * S.w + i] ? 1 : 0.78;
}

// =====================================================================
//  Bot routes: bots follow a small waypoint graph round the buildings
// =====================================================================
function segBoxHit(ax: number, az: number, bx: number, bz: number, o: RuntimeObstacle, pad: number) {
  const s = Math.sin(o.yaw),
    c = Math.cos(o.yaw);
  const lx0 = (ax - o.x) * c - (az - o.z) * s,
    lz0 = (ax - o.x) * s + (az - o.z) * c;
  const lx1 = (bx - o.x) * c - (bz - o.z) * s,
    lz1 = (bx - o.x) * s + (bz - o.z) * c;
  const hw = o.hw + pad,
    hl = o.hl + pad;
  let t0 = 0,
    t1 = 1;
  for (const [p0, p1, h] of [
    [lx0, lx1, hw],
    [lz0, lz1, hl],
  ] satisfies [number, number, number][]) {
    const d = p1 - p0;
    if (Math.abs(d) < 1e-9) {
      if (p0 < -h || p0 > h) return false;
      continue;
    }
    let a = (-h - p0) / d,
      b = (h - p0) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}
function segsCross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax),
    d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx),
    d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
// Can a car drive straight from a to b without hitting a building, a big obstacle or the edge?
export function segmentClear(ax: number, az: number, bx: number, bz: number, pad = 1.3) {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.01) return true;
  const x0 = Math.min(ax, bx) - pad,
    x1 = Math.max(ax, bx) + pad,
    z0 = Math.min(az, bz) - pad,
    z1 = Math.max(az, bz) + pad;
  for (const o of OBSTACLES) {
    if (o.down) continue;
    const br = o.br || (o.br = o.kind === 'circle' ? o.r : Math.hypot(o.hw, o.hl));
    if (o.x + br < x0 || o.x - br > x1 || o.z + br < z0 || o.z - br > z1) continue;
    if (o.kind === 'circle') {
      if (o.r < 0.9) continue; // trees and lamp posts are easy to steer round
      const ux = (bx - ax) / len,
        uz = (bz - az) / len;
      const t = clamp((o.x - ax) * ux + (o.z - az) * uz, 0, len);
      if (Math.hypot(ax + ux * t - o.x, az + uz * t - o.z) < o.r + pad) return false;
    } else if (segBoxHit(ax, az, bx, bz, o, pad)) return false;
  }
  const P = BOUNDS.pts;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++)
    if (
      segsCross(
        ax,
        az,
        bx,
        bz,
        requireValue(P[j])[0],
        requireValue(P[j])[1],
        requireValue(P[i])[0],
        requireValue(P[i])[1],
      )
    )
      return false;
  return true;
}

export function buildNav(nodes: Pt[]) {
  const n = nodes.length;
  const D: number[][] = [],
    next: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array(n).fill(Infinity));
    next.push(new Array(n).fill(-1));
    requireValue(D[i])[i] = 0;
    requireValue(next[i])[i] = i;
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (
        !segmentClear(
          requireValue(nodes[i])[0],
          requireValue(nodes[i])[1],
          requireValue(nodes[j])[0],
          requireValue(nodes[j])[1],
          1.1,
        )
      )
        continue;
      requireValue(D[i])[j] = requireValue(D[j])[i] = Math.hypot(
        requireValue(nodes[i])[0] - requireValue(nodes[j])[0],
        requireValue(nodes[i])[1] - requireValue(nodes[j])[1],
      );
      requireValue(next[i])[j] = j;
      requireValue(next[j])[i] = i;
    }
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (
          requireValue(requireValue(D[i])[k]) + requireValue(requireValue(D[k])[j]) <
          requireValue(requireValue(D[i])[j])
        ) {
          requireValue(D[i])[j] = requireValue(requireValue(D[i])[k]) + requireValue(requireValue(D[k])[j]);
          requireValue(next[i])[j] = requireValue(requireValue(next[i])[k]);
        }
      }
  return { nodes, D, next };
}

// Where should a bot at (x, z) head to reach (tx, tz)? null = straight there.
export function navStep(x: number, z: number, tx: number, tz: number) {
  if (segmentClear(x, z, tx, tz, 0.9)) return null;
  const N = NAV.nodes,
    from = [],
    to = [];
  for (let i = 0; i < N.length; i++) {
    if (segmentClear(x, z, requireValue(N[i])[0], requireValue(N[i])[1], 0.9)) from.push(i);
    if (segmentClear(tx, tz, requireValue(N[i])[0], requireValue(N[i])[1], 0.9)) to.push(i);
  }
  let best = Infinity,
    bi = -1,
    bj = -1;
  for (const i of from)
    for (const j of to) {
      const c =
        Math.hypot(requireValue(N[i])[0] - x, requireValue(N[i])[1] - z) +
        requireValue(requireValue(NAV.D[i])[j]) +
        Math.hypot(requireValue(N[j])[0] - tx, requireValue(N[j])[1] - tz);
      if (c < best) {
        best = c;
        bi = i;
        bj = j;
      }
    }
  if (bi < 0) return null;
  let k = bi;
  if (Math.hypot(requireValue(N[k])[0] - x, requireValue(N[k])[1] - z) < 5 && k !== bj)
    k = requireValue(requireValue(NAV.next[k])[bj]);
  return requireValue(N[k]);
}

// =====================================================================
//  Random starting spots: anywhere on the tarmac, clear of obstacles and well apart
// =====================================================================
export function spotClear(x: number, z: number, r: number) {
  for (const o of OBSTACLES) {
    if (o.down) continue;
    if (o.kind === 'circle' ? Math.hypot(o.x - x, o.z - z) < o.r + r : segBoxHit(x, z, x + 0.01, z, o, r))
      return false;
  }
  return true;
}
// taken: start slots already handed out (the town's own), to keep clear of
export function randomSpawns(n: number, taken: { x: number; z: number; yaw: number }[] = []) {
  const S = SURFACE,
    slots = [...taken];
  n += taken.length;
  let gap = 18;
  for (let tries = 1; slots.length < n && tries < 6000; tries++) {
    if (tries % 1000 === 0) gap *= 0.75; // a crowded draw: allow closer starts
    const x = rand(S.x0, S.x0 + S.w),
      z = rand(S.z0, S.z0 + S.h);
    if (surfaceGrip(x, z) < 1 || arenaSDF(x, z) > -4 || !spotClear(x, z, 3.4)) continue;
    if (slots.some((p) => Math.hypot(p.x - x, p.z - z) < gap)) continue;
    slots.push({ x, z, yaw: startYaw(x, z) });
  }
  while (slots.length < n) slots.push({ x: (slots.length - n / 2) * 6, z: 0, yaw: 0 }); // (never short of a spot, however crowded)
  return slots.slice(taken.length);
}

// A start faces open road (in the town the middle is often behind a block): of the ways with about 28 m
// clear ahead, the one nearest the middle.
function startYaw(x: number, z: number): number {
  const mid = Math.atan2(-x, -z);
  let best = mid,
    bestScore = -Infinity;
  for (let k = 0; k < 24; k++) {
    const yaw = mid + rand(-0.12, 0.12) + (k / 24) * TAU,
      sx = Math.sin(yaw),
      cz = Math.cos(yaw);
    let run = 0;
    while (
      run < 28 &&
      arenaSDF(x + sx * (run + 4), z + cz * (run + 4)) < -2 &&
      segmentClear(x, z, x + sx * (run + 4), z + cz * (run + 4), 1.6)
    )
      run += 4;
    const score = run - Math.abs(wrapPi(yaw - mid)) * 3;
    if (score > bestScore) {
      bestScore = score;
      best = yaw;
    }
  }
  return best;
}

export function setSURFACE(value: typeof SURFACE): void {
  SURFACE = value;
}
export function setNAV(value: typeof NAV): void {
  NAV = value;
}
