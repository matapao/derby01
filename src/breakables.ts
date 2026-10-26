import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import type { RuntimeObstacle } from './world.ts';
import * as THREE from 'three';
import { TAU, _v1, _v2, pick, rand } from './core.ts';
import { G } from './state.ts';
import { shakeCarCrew } from './crew-effects.ts';
import { GLOW, addDebris, dust, sparks } from './fx.ts';
import { SFX } from './audio.ts';
import { FX, share } from './net/effects.ts';
import { OBSTACLES } from './world.ts';
export type BreakablePart = [THREE.Mesh, number | null, boolean?];
export interface Breakable {
  ob: RuntimeObstacle & { breakable: NonNullable<RuntimeObstacle['breakable']> };
  kind: string;
  angle: number;
  vel: number;
  dir: [number, number];
  falling: boolean;
  shattered: boolean;
  parts: { mesh: THREE.Mesh; index: number | null; hide: boolean; base: THREE.Matrix4 }[];
}

// =====================================================================
//  Things that give way: lamp posts, trees and bollards. A car that hits one hard enough knocks it
//  flat (and loses a bit of speed); a slow nudge still stops you. Trees snap: the trunk breaks into logs
//  and the crown into clumps of leaves, which land on the tarmac where cars shove them about or run
//  over them. Everything stands up again next round. How hard, how much it slows and hurts the car,
//  and whether it tips or snaps: its piece's breakable component (data/pieces.json), on its obstacle.
//  kind is only how it looks: 'tree', 'poplar', 'lamp' or 'bollard'.
// =====================================================================
const REST = 1.5; // how far over a tipped piece lies, unless its component says
export const BREAKABLES: Breakable[] = [];
const _brkM = new THREE.Matrix4(),
  _brkM2 = new THREE.Matrix4(),
  _brkT = new THREE.Matrix4(),
  _brkQ = new THREE.Quaternion(),
  _brkAx = new THREE.Vector3();
const _brkP = new THREE.Vector3(),
  _brkE = new THREE.Euler();
// the bits a tree breaks into: a log, and lumpy clumps of leaves (green with the odd red berry, like the crowns)
const LOG_GEO = new THREE.CylinderGeometry(0.12, 0.14, 1.1, 7);
const LEAF_CLUMPS = [0, 1, 2].map((k) => {
  const g = new THREE.IcosahedronGeometry(1, 1),
    p = g.getAttribute('position'),
    n = p.count;
  for (let i = 0; i < n; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i),
      w = 1 + 0.22 * Math.sin(x * 3.1 + k * 2) * Math.cos(z * 2.7 - y * 1.9 + k);
    p.setXYZ(i, x * w, y * w * 0.85, z * w);
  }
  const col = new Float32Array(n * 3),
    tmp = new THREE.Color();
  for (let i = 0; i < n; i += 3) {
    const shade = rand(0.75, 1.05);
    if (Math.random() < 0.06) tmp.setRGB(0.66, 0.14, 0.09, THREE.SRGBColorSpace);
    else tmp.setRGB(0.27 * shade, 0.45 * shade, 0.19 * shade, THREE.SRGBColorSpace);
    for (let j = 0; j < 3; j++) col.set([tmp.r, tmp.g, tmp.b], (i + j) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
});
const TREE_BITS_MAX = 140; // older bits sink away when there are more lying about

// parts: [mesh, instance index (null for a plain mesh), hide when down]
export function makeBreakable(ob: RuntimeObstacle, kind: string, parts: BreakablePart[]) {
  if (!ob.breakable || !parts.length) throw new Error('Breakable needs a component and render parts');
  const b: Breakable = {
    ob: Object.assign(ob, { breakable: ob.breakable }),
    kind,
    angle: 0,
    vel: 0,
    dir: [1, 0],
    falling: false,
    shattered: false,
    parts: [],
  };
  for (const [mesh, index, hide] of parts) {
    const base = new THREE.Matrix4();
    if (index == null) {
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      base.copy(mesh.matrix);
    } else {
      if (!(mesh instanceof THREE.InstancedMesh))
        throw new Error('Breakable instance needs an instanced mesh');
      mesh.getMatrixAt(index, base);
    }
    b.parts.push({ mesh, index, hide: !!hide, base });
  }
  ob.brk = b;
  BREAKABLES.push(b);
}

// A car runs into one: fast enough and over it goes. Returns true when it gave way.
export function hitBreakable(
  car: Car,
  o: RuntimeObstacle,
  nx: number,
  nz: number,
  damage: (car: Car, amount: number) => void,
) {
  const B = o.breakable;
  if (!B) return false;
  const vn = car.vel.x * nx + car.vel.z * nz; // how fast the car is going at it
  if (vn < B.speed || G.state === 'menu') return false;
  const l = Math.hypot(car.vel.x, car.vel.z) || 1;
  knockOver(OBSTACLES.indexOf(o), car.vel.x / l, car.vel.z / l, vn, car);
  car.vel.x *= B.slow;
  car.vel.z *= B.slow;
  if (G.state === 'playing') damage(car, B.dmg);
  return true;
}

// Obstacle number index goes over the way (dx, dz) at speed vn (on every screen alike: the arena is
// built the same everywhere, so the numbers match). car: whose crew feels it, if anyone's.
export function knockOver(index: number, dx: number, dz: number, vn: number, car: Car | null) {
  if (share(FX.breakProp, knockOver, [index, dx, dz, vn, car])) return;
  const o = OBSTACLES[index],
    b = o && o.brk;
  if (!b || o.down) return;
  o.down = true;
  b.dir = [dx, dz];
  const tips = b.ob.breakable.fall === 'tip';
  if (!tips) shatterTree(b, vn);
  else {
    b.falling = true;
    b.angle = 0;
    b.vel = 1.2 + vn * 0.16;
  }
  const y = Math.min(1, o.h * 0.6);
  if (tips) sparks(o.x, y, o.z, 14, 4);
  else
    for (let i = 0; i < 22; i++)
      GLOW.emit({
        x: o.x + rand(-1, 1),
        y: rand(2.5, 5),
        z: o.z + rand(-1, 1),
        vx: rand(-2, 2),
        vy: rand(-0.5, 1.5),
        vz: rand(-2, 2),
        life: rand(0.8, 1.6),
        s0: rand(0.12, 0.22),
        s1: 0.05,
        c0: [0.3, 0.55, 0.2, 1],
        c1: [0.25, 0.45, 0.15, 0],
      }); // leaves
  SFX.crash(_v2.set(o.x, y, o.z), vn * 0.5);
  if (b.kind === 'lamp') SFX.clank(_v2.set(o.x, 3, o.z));
  else if (b.kind !== 'bollard') SFX.thud(_v2.set(o.x, 1, o.z));
  if (car) shakeCarCrew(car, vn * 0.03);
}

// The tree snaps off above a stump: two logs and a few clumps of crown fly on the way the car was going.
function shatterTree(b: Breakable, vn: number) {
  b.shattered = true;
  applyBreakable(b);
  const o = b.ob,
    [dx, dz] = b.dir,
    poplar = b.kind === 'poplar';
  const trunkMat = requireValue(b.parts[0]).mesh.material,
    leafMat = (b.parts[1] ?? requireValue(b.parts[0])).mesh.material; // (a piece drawn as one mesh breaks into bits of it)
  const piece = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
    y: number,
    sx: number,
    sy: number,
    opt: import('./fx.ts').DebrisOpts,
    upright = false,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sx);
    m.castShadow = true;
    const a = rand(0, TAU),
      out = rand(0.4, 2.2),
      fwd = vn * rand(0.35, 0.75);
    const vel = new THREE.Vector3(dx * fwd + Math.cos(a) * out, rand(1.5, 4), dz * fwd + Math.sin(a) * out);
    if (upright) _brkQ.identity();
    else _brkQ.setFromEuler(_brkE.set(rand(0, TAU), rand(0, TAU), rand(0, TAU)));
    addDebris(m, _brkP.set(o.x + rand(-0.3, 0.3), y, o.z + rand(-0.3, 0.3)), _brkQ, vel, rand(70, 90), {
      tree: true,
      ...opt,
    });
  };
  for (const y of [0.9, 2.0])
    piece(LOG_GEO, trunkMat, y, 1, 1, { r: 0.55, rest: 0.13, heavy: true, lie: true }, true);
  for (let k = 0, n = poplar ? 4 : 3; k < n; k++) {
    const sc = rand(0.6, 0.85);
    piece(
      pick(LEAF_CLUMPS),
      leafMat,
      poplar ? 3.4 + k * 1.9 : 3.6 + rand(-0.6, 0.6),
      sc,
      sc * (poplar ? 1.5 : 1),
      { r: sc, rest: sc * 0.6 },
    );
  }
  const bits = G.debris.filter((d) => d.tree);
  for (let k = 0; k < bits.length - TREE_BITS_MAX; k++)
    requireValue(bits[k]).life = Math.min(requireValue(bits[k]).life, 0);
}

function applyBreakable(b: Breakable) {
  const x = b.ob.x,
    z = b.ob.z;
  _brkAx.set(b.dir[1], 0, -b.dir[0]); // the axis it tips over about: it falls the way the car was going
  _brkQ.setFromAxisAngle(_brkAx, b.angle);
  _brkM.makeRotationFromQuaternion(_brkQ);
  _brkM.premultiply(_brkT.makeTranslation(x, 0, z)).multiply(_brkT.makeTranslation(-x, 0, -z));
  for (const p of b.parts) {
    if (b.shattered) {
      // a stump is all that's left
      const stump = p === b.parts[0];
      _brkM2.copy(p.base).scale(_v1.set(stump ? 1 : 0.001, stump ? 0.12 : 0.001, stump ? 1 : 0.001));
    } else _brkM2.multiplyMatrices(_brkM, p.base);
    if (p.hide && b.ob.down) _brkM2.scale(_v1.set(0.001, 0.001, 0.001)); // a lamp that's down goes dark
    if (p.index == null) {
      p.mesh.matrix.copy(_brkM2);
      p.mesh.matrixWorldNeedsUpdate = true;
    } else {
      if (!(p.mesh instanceof THREE.InstancedMesh))
        throw new Error('Breakable instance needs an instanced mesh');
      p.mesh.setMatrixAt(p.index, _brkM2);
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

export function updateBreakables(dt: number) {
  for (const b of BREAKABLES) {
    if (!b.falling) continue;
    const rest = b.ob.breakable.rest ?? REST;
    b.vel += dt * (2.5 + 9 * Math.sin(b.angle)); // gravity pulls it over faster and faster
    b.angle += b.vel * dt;
    if (b.angle >= rest) {
      b.angle = rest;
      b.falling = false;
      const len = b.ob.h;
      dust(b.ob.x + b.dir[0] * len * 0.8, 0.2, b.ob.z + b.dir[1] * len * 0.8, len < 2 ? 1 : 4);
    }
    applyBreakable(b);
  }
}

// Already over when this screen joined the round: lying where it fell, without the show.
export function setDown(index: number, dx: number, dz: number) {
  const o = OBSTACLES[index],
    b = o && o.brk;
  if (!b || o.down) return;
  o.down = true;
  b.dir = [dx, dz];
  if (b.ob.breakable.fall !== 'tip') b.shattered = true;
  else b.angle = b.ob.breakable.rest ?? REST;
  applyBreakable(b);
}

// a new round: everything stands up again
export function resetBreakables() {
  for (const b of BREAKABLES) {
    if (!b.ob.down && !b.falling && b.angle === 0 && !b.shattered) continue;
    b.ob.down = false;
    b.falling = false;
    b.shattered = false;
    b.angle = 0;
    b.vel = 0;
    applyBreakable(b);
  }
}
