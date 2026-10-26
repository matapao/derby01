import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import * as THREE from 'three';
import { D } from './data.ts';
import { SFX } from './audio.ts';
import { CARDIM, TAU, TEAMS, _q1, _v1, _v2, pick, rand } from './core.ts';
import { OBSTACLES, arenaNormal, arenaSDF, scene } from './world.ts';
import { G } from './state.ts';
import { shakeCarCrew } from './crew-effects.ts';
import { KIT_EXHAUSTS } from './kit-data.ts';

// =====================================================================
//  Particles (two point clouds: additive glow + soft smoke)
// =====================================================================
const PARTICLE_VS = /* glsl */ `
  attribute float aSize; attribute vec4 aColor;
  uniform float uScale; varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const PARTICLE_FS = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  }`;
export const particleScale = { value: 400 };

// one particle: where, how fast, how long, size and colour from start to end, gravity and air drag
export interface Particle {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  s0: number;
  s1?: number;
  c0: number[];
  c1?: number[];
  grav?: number;
  drag?: number;
}

class ParticleSystem {
  readonly max: number;
  n = 0;
  readonly p: Float32Array;
  readonly v: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly s0: Float32Array;
  readonly s1: Float32Array;
  readonly c0: Float32Array;
  readonly c1: Float32Array;
  readonly grav: Float32Array;
  readonly drag: Float32Array;
  readonly geo = new THREE.BufferGeometry();
  readonly aPos: THREE.BufferAttribute;
  readonly aSize: THREE.BufferAttribute;
  readonly aColor: THREE.BufferAttribute;
  readonly points: THREE.Points;
  constructor(max: number, additive: boolean) {
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4);
    this.c1 = new Float32Array(max * 4);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('aSize', this.aSize);
    this.geo.setAttribute('aColor', this.aColor);
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: particleScale },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }
  emit(o: Particle): void {
    let i = this.n;
    if (i >= this.max) i = (Math.random() * this.max) | 0;
    else this.n++;
    this.p[i * 3] = o.x;
    this.p[i * 3 + 1] = o.y;
    this.p[i * 3 + 2] = o.z;
    this.v[i * 3] = o.vx || 0;
    this.v[i * 3 + 1] = o.vy || 0;
    this.v[i * 3 + 2] = o.vz || 0;
    this.life[i] = this.maxLife[i] = o.life;
    this.s0[i] = o.s0;
    this.s1[i] = o.s1 ?? o.s0;
    this.c0.set(o.c0, i * 4);
    this.c1.set(o.c1 || o.c0, i * 4);
    this.grav[i] = o.grav || 0;
    this.drag[i] = o.drag || 0;
  }
  update(dt: number): void {
    const { p, v } = this;
    const P = this.aPos.array,
      S = this.aSize.array,
      C = this.aColor.array;
    for (let i = 0; i < this.n; i++) {
      this.life[i] = requireValue(this.life[i]) - dt;
      if (requireValue(this.life[i]) <= 0) {
        this.copy(--this.n, i);
        i--;
        continue;
      }
      const k = Math.exp(-requireValue(this.drag[i]) * dt);
      v[i * 3] = requireValue(v[i * 3]) * k;
      v[i * 3 + 1] = requireValue(v[i * 3 + 1]) * k - requireValue(this.grav[i]) * dt;
      v[i * 3 + 2] = requireValue(v[i * 3 + 2]) * k;
      p[i * 3] = requireValue(p[i * 3]) + requireValue(v[i * 3]) * dt;
      p[i * 3 + 1] = requireValue(p[i * 3 + 1]) + requireValue(v[i * 3 + 1]) * dt;
      p[i * 3 + 2] = requireValue(p[i * 3 + 2]) + requireValue(v[i * 3 + 2]) * dt;
      if (requireValue(p[i * 3 + 1]) < 0.02) {
        p[i * 3 + 1] = 0.02;
        v[i * 3 + 1] = requireValue(v[i * 3 + 1]) * -0.3;
      }
    }
    for (let i = 0; i < this.n; i++) {
      const t = 1 - requireValue(this.life[i]) / requireValue(this.maxLife[i]);
      P[i * 3] = requireValue(p[i * 3]);
      P[i * 3 + 1] = requireValue(p[i * 3 + 1]);
      P[i * 3 + 2] = requireValue(p[i * 3 + 2]);
      S[i] = requireValue(this.s0[i]) + (requireValue(this.s1[i]) - requireValue(this.s0[i])) * t;
      for (let c = 0; c < 4; c++)
        C[i * 4 + c] =
          requireValue(this.c0[i * 4 + c]) +
          (requireValue(this.c1[i * 4 + c]) - requireValue(this.c0[i * 4 + c])) * t;
    }
    this.geo.setDrawRange(0, this.n);
    // upload only the live particles, and nothing at all when none are alive
    if (this.n)
      for (const a of [this.aPos, this.aSize, this.aColor]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.n * a.itemSize);
        a.needsUpdate = true;
      }
  }
  copy(from: number, to: number): void {
    if (from === to) return;
    for (let c = 0; c < 3; c++) {
      this.p[to * 3 + c] = requireValue(this.p[from * 3 + c]);
      this.v[to * 3 + c] = requireValue(this.v[from * 3 + c]);
    }
    for (let c = 0; c < 4; c++) {
      this.c0[to * 4 + c] = requireValue(this.c0[from * 4 + c]);
      this.c1[to * 4 + c] = requireValue(this.c1[from * 4 + c]);
    }
    this.life[to] = requireValue(this.life[from]);
    this.maxLife[to] = requireValue(this.maxLife[from]);
    this.s0[to] = requireValue(this.s0[from]);
    this.s1[to] = requireValue(this.s1[from]);
    this.grav[to] = requireValue(this.grav[from]);
    this.drag[to] = requireValue(this.drag[from]);
  }
  clear(): void {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }
}
export const GLOW = new ParticleSystem(3000, true);
export const SMOKE = new ParticleSystem(2600, false);

export function sparks(x: number, y: number, z: number, count: number, strength = 5) {
  for (let i = 0; i < count; i++) {
    const sp = rand(2, 5 + strength);
    GLOW.emit({
      x,
      y,
      z,
      vx: rand(-1, 1) * sp,
      vy: rand(0.3, 1.4) * sp,
      vz: rand(-1, 1) * sp,
      life: rand(0.25, 0.6),
      s0: rand(0.08, 0.16),
      s1: 0.02,
      c0: [1, 0.85, 0.45, 1],
      c1: [1, 0.35, 0.05, 0.6],
      grav: 16,
      drag: 1.5,
    });
  }
}
export function dust(x: number, y: number, z: number, count: number) {
  for (let i = 0; i < count; i++) {
    SMOKE.emit({
      x: x + rand(-0.8, 0.8),
      y,
      z: z + rand(-0.8, 0.8),
      vx: rand(-2, 2),
      vy: rand(0.5, 2),
      vz: rand(-2, 2),
      life: rand(0.9, 1.8),
      s0: rand(0.8, 1.4),
      s1: rand(2.5, 4),
      c0: [0.62, 0.5, 0.38, 0.5],
      c1: [0.62, 0.52, 0.42, 0],
      drag: 1.6,
    });
  }
}
export function smokePuff(x: number, y: number, z: number, dark: boolean, size = 1) {
  const g = dark ? rand(0.08, 0.16) : rand(0.45, 0.6);
  SMOKE.emit({
    x,
    y,
    z,
    vx: rand(-0.4, 0.4),
    vy: rand(1.2, 2.4),
    vz: rand(-0.4, 0.4),
    life: rand(1.4, 2.6),
    s0: 0.6 * size,
    s1: rand(2.2, 3.4) * size,
    c0: [g, g, g, dark ? 0.7 : 0.45],
    c1: [g * 1.2, g * 1.2, g * 1.2, 0],
    drag: 0.4,
  });
}
export function fireLick(x: number, y: number, z: number, size = 1) {
  GLOW.emit({
    x: x + rand(-0.3, 0.3),
    y,
    z: z + rand(-0.3, 0.3),
    vx: rand(-0.3, 0.3),
    vy: rand(1.5, 3),
    vz: rand(-0.3, 0.3),
    life: rand(0.35, 0.7),
    s0: rand(0.6, 1.0) * size,
    s1: 0.15,
    c0: [1, 0.62, 0.18, 0.9],
    c1: [0.9, 0.18, 0.05, 0],
    drag: 0.6,
  });
}
// =====================================================================
//  Confetti: when a car is out it goes off like a party popper. Paper bits shoot up,
//  tumble, flutter down, lie on the ground for a while and then fade.
// =====================================================================
const CONFETTI_MAX = 8000;
const confettiMesh = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(0.14, 0.085),
  new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.55, metalness: 0.15 }),
  CONFETTI_MAX,
);
confettiMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CONFETTI_MAX * 3), 3);
confettiMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
confettiMesh.frustumCulled = false;
confettiMesh.count = 0;
scene.add(confettiMesh);
const CF = {
  n: 0,
  p: new Float32Array(CONFETTI_MAX * 3),
  v: new Float32Array(CONFETTI_MAX * 3),
  axis: new Float32Array(CONFETTI_MAX * 3),
  ang: new Float32Array(CONFETTI_MAX),
  spin: new Float32Array(CONFETTI_MAX),
  phase: new Float32Array(CONFETTI_MAX),
  life: new Float32Array(CONFETTI_MAX),
  col: new Float32Array(CONFETTI_MAX * 3),
  landed: new Uint8Array(CONFETTI_MAX),
};
const CONFETTI_COLORS = [...TEAMS.map((t) => t.ui), '#ffffff', '#ffd24a', '#ffe9a8', '#c0f0ff'].map(
  (c) => new THREE.Color(c),
);

export function confettiBurst(x: number, y: number, z: number, count = 900) {
  for (let k = 0; k < count; k++) {
    let i = CF.n;
    if (i >= CONFETTI_MAX) i = (Math.random() * CONFETTI_MAX) | 0;
    else CF.n++;
    const a = rand(0, TAU),
      out = rand(0.5, 6),
      up = rand(7, 17);
    CF.p.set([x + rand(-0.6, 0.6), y + rand(0, 0.6), z + rand(-0.6, 0.6)], i * 3);
    CF.v.set([Math.cos(a) * out, up, Math.sin(a) * out], i * 3);
    const ax = rand(-1, 1),
      ay = rand(-1, 1),
      az = rand(-1, 1),
      al = Math.hypot(ax, ay, az) || 1;
    CF.axis.set([ax / al, ay / al, az / al], i * 3);
    CF.ang[i] = rand(0, TAU);
    CF.spin[i] = rand(6, 16) * (Math.random() < 0.5 ? -1 : 1);
    CF.phase[i] = rand(0, TAU);
    CF.life[i] = rand(7, 11);
    CF.landed[i] = 0;
    const c = pick(CONFETTI_COLORS);
    CF.col.set([c.r, c.g, c.b], i * 3);
  }
}

const _cq = new THREE.Quaternion(),
  _ca = new THREE.Vector3(),
  _cs = new THREE.Vector3(),
  _cp = new THREE.Vector3(),
  _cm = new THREE.Matrix4(),
  _cc = new THREE.Color();
const _ce = new THREE.Euler();
export function updateConfetti(dt: number) {
  const { p, v } = CF;
  for (let i = 0; i < CF.n; i++) {
    CF.life[i] = requireValue(CF.life[i]) - dt;
    if (requireValue(CF.life[i]) <= 0) {
      confettiCopy(--CF.n, i);
      i--;
      continue;
    }
    if (!CF.landed[i]) {
      // paper: gravity, lots of air drag, and a side-to-side flutter on the way down
      v[i * 3 + 1] = requireValue(v[i * 3 + 1]) - 9.8 * dt;
      const drag = Math.exp(-(requireValue(v[i * 3 + 1]) < 0 ? 3.2 : 0.9) * dt);
      v[i * 3] = requireValue(v[i * 3]) * drag;
      v[i * 3 + 1] = requireValue(v[i * 3 + 1]) * drag;
      v[i * 3 + 2] = requireValue(v[i * 3 + 2]) * drag;
      const fl = Math.sin(G.time * 5 + requireValue(CF.phase[i])) * 1.4;
      p[i * 3] =
        requireValue(p[i * 3]) + (requireValue(v[i * 3]) + fl * Math.cos(requireValue(CF.phase[i]))) * dt;
      p[i * 3 + 1] = requireValue(p[i * 3 + 1]) + requireValue(v[i * 3 + 1]) * dt;
      p[i * 3 + 2] =
        requireValue(p[i * 3 + 2]) +
        (requireValue(v[i * 3 + 2]) + fl * Math.sin(requireValue(CF.phase[i]))) * dt;
      CF.ang[i] = requireValue(CF.ang[i]) + requireValue(CF.spin[i]) * dt;
      if (requireValue(p[i * 3 + 1]) <= 0.02) {
        p[i * 3 + 1] = 0.02 + (i % 7) * 0.001;
        CF.landed[i] = 1;
        CF.life[i] = Math.min(requireValue(CF.life[i]), rand(2.5, 5));
      }
    }
  }
  const n = CF.n;
  for (let i = 0; i < n; i++) {
    if (CF.landed[i])
      _cq.setFromEuler(_ce.set(-Math.PI / 2, 0, requireValue(CF.phase[i]))); // lying flat
    else
      _cq.setFromAxisAngle(
        _ca.set(requireValue(CF.axis[i * 3]), requireValue(CF.axis[i * 3 + 1]), CF.axis[i * 3 + 2]),
        requireValue(CF.ang[i]),
      );
    const s = Math.min(1, requireValue(CF.life[i]) / 0.8); // shrink away at the end
    _cs.set(s, s, s);
    _cm.compose(_cp.set(requireValue(p[i * 3]), requireValue(p[i * 3 + 1]), p[i * 3 + 2]), _cq, _cs);
    confettiMesh.setMatrixAt(i, _cm);
    confettiMesh.setColorAt(
      i,
      _cc.setRGB(
        requireValue(CF.col[i * 3]),
        requireValue(CF.col[i * 3 + 1]),
        requireValue(CF.col[i * 3 + 2]),
      ),
    );
  }
  confettiMesh.count = n;
  if (n)
    for (const a of [confettiMesh.instanceMatrix, confettiMesh.instanceColor]) {
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
}
function confettiCopy(from: number, to: number) {
  if (from === to) return;
  for (const k of ['p', 'v', 'axis', 'col'] as const)
    for (let c = 0; c < 3; c++) requireValue(CF[k])[to * 3 + c] = requireValue(CF[k][from * 3 + c]);
  for (const k of ['ang', 'spin', 'phase', 'life', 'landed'] as const)
    requireValue(CF[k])[to] = requireValue(CF[k][from]);
}
export function clearConfetti() {
  CF.n = 0;
  confettiMesh.count = 0;
}

// =====================================================================
//  Skid marks, debris
// =====================================================================

const SKID_MAX = 2400;
export const skid = (() => {
  const pos = new Float32Array(SKID_MAX * 4 * 3);
  const idx = new Uint32Array(SKID_MAX * 6);
  for (let i = 0; i < SKID_MAX; i++)
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: 0x1a120c,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);
  return { pos, geo, mesh, head: 0, used: 0 };
})();
export function addSkid(ax: number, az: number, bx: number, bz: number, width: number) {
  const dx = bx - ax,
    dz = bz - az,
    l = Math.hypot(dx, dz);
  if (l < 0.05 || l > 3) return;
  const nx = (-dz / l) * width * 0.5,
    nz = (dx / l) * width * 0.5,
    y = 0.02;
  const i = skid.head;
  skid.pos.set([ax + nx, y, az + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz], i * 12);
  skid.head = (i + 1) % SKID_MAX;
  skid.used = Math.min(SKID_MAX, skid.used + 1);
  const a = skid.geo.getAttribute('position') as THREE.BufferAttribute;
  a.addUpdateRange(i * 12, 12); // just the new quad
  a.needsUpdate = true;
  skid.geo.setDrawRange(0, skid.used * 6);
}
export function clearSkids() {
  skid.head = skid.used = 0;
  skid.geo.setDrawRange(0, 0);
}

export interface DebrisOpts {
  r?: number; // size
  rest?: number; // height of its middle when lying on the ground
  heavy?: boolean; // a log: pushed along rather than flung
  lie?: boolean; // comes to rest lying on its side
  tree?: boolean; // one of the bits a tree broke into
}
export function addDebris(
  mesh: THREE.Object3D,
  pos: THREE.Vector3,
  quat: THREE.Quaternion,
  vel: THREE.Vector3,
  life: number,
  opt: DebrisOpts = {},
): void {
  scene.add(mesh);
  mesh.position.copy(pos);
  mesh.quaternion.copy(quat);
  const r =
    mesh instanceof THREE.Mesh && mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.radius : 0.4; // (a kit part is a group: about half a metre)
  G.debris.push({
    mesh,
    vel,
    spin: new THREE.Vector3(rand(-6, 6), rand(-6, 6), rand(-6, 6)),
    life,
    r: opt.r ?? Math.min(r, 0.5),
    ...(opt.rest === undefined ? {} : { rest: opt.rest }),
    heavy: !!opt.heavy,
    lie: !!opt.lie,
    tree: !!opt.tree,
    lying: false,
    still: false,
    bumpT: 0,
  });
}
// Take a piece off the scene, freeing the geometry it carried as its own (a dented door or hood:
// shared geometry, like the logs', stays).
function removeDebris(d: import('./gameplay/model.ts').DebrisState) {
  scene.remove(d.mesh);
  d.mesh.traverse((o) => {
    if (o instanceof THREE.Mesh && (o.geometry.userData['orig'] || o.geometry.userData['own']))
      o.geometry.dispose();
  });
}
export function clearDebris() {
  for (const d of G.debris) removeDebris(d);
  G.debris.length = 0;
}
const _dUp = new THREE.Vector3(0, 1, 0),
  _dAx = new THREE.Vector3();
export function updateDebris(dt: number) {
  for (let i = G.debris.length - 1; i >= 0; i--) {
    const d = requireValue(G.debris[i]);
    d.life -= dt;
    const m = d.mesh;
    if (!d.still) {
      // (bits lying still skip all this until a car comes along)
      d.vel.y -= D.physics.gravity * dt;
      m.position.addScaledVector(d.vel, dt);
      const gh = d.rest ?? d.r * 0.5; // (the ground is flat, at y = 0)
      if (m.position.y < gh) {
        m.position.y = gh;
        if (d.vel.y < -1.5) d.vel.y *= -0.3;
        else d.vel.y = 0;
        const f = d.heavy ? 0.72 : 0.82;
        d.vel.x *= f;
        d.vel.z *= f;
        d.spin.multiplyScalar(0.8);
        if (d.lie && !d.lying && d.vel.y === 0) {
          // a log falls over onto its side
          _dAx.copy(_dUp).applyQuaternion(m.quaternion).setY(0);
          if (_dAx.lengthSq() < 1e-4) _dAx.set(Math.cos(i), 0, Math.sin(i));
          m.quaternion.setFromUnitVectors(_dUp, _dAx.normalize());
          d.lying = true;
          d.spin.set(0, d.spin.y * 0.3, 0);
        }
        if (d.vel.y === 0 && d.vel.x * d.vel.x + d.vel.z * d.vel.z < 0.02 && d.spin.lengthSq() < 0.02) {
          d.still = true;
          d.vel.set(0, 0, 0);
          d.spin.set(0, 0, 0);
        }
      }
      for (const o of OBSTACLES) {
        if (o.down || m.position.y > o.h) continue;
        if (o.kind === 'circle') {
          const dx = m.position.x - o.x,
            dz = m.position.z - o.z,
            dl = Math.hypot(dx, dz),
            r = o.r + 0.15;
          if (dl >= r || dl < 1e-4) continue;
          m.position.x = o.x + (dx / dl) * r;
          m.position.z = o.z + (dz / dl) * r;
          const vn = (d.vel.x * dx + d.vel.z * dz) / dl;
          if (vn < 0) {
            d.vel.x -= (1.5 * vn * dx) / dl;
            d.vel.z -= (1.5 * vn * dz) / dl;
          }
        } else {
          const s = Math.sin(o.yaw),
            c = Math.cos(o.yaw),
            rx = m.position.x - o.x,
            rz = m.position.z - o.z;
          const lx = rx * c - rz * s,
            lz = rx * s + rz * c,
            ox = o.hw + 0.15 - Math.abs(lx),
            oz = o.hl + 0.15 - Math.abs(lz);
          if (ox <= 0 || oz <= 0) continue;
          // push out through the nearest face and bounce
          if (ox < oz) {
            const sx = Math.sign(lx) || 1;
            m.position.x += c * sx * ox;
            m.position.z -= s * sx * ox;
            const vn = (d.vel.x * c - d.vel.z * s) * sx;
            if (vn < 0) {
              d.vel.x -= 1.5 * vn * c * sx;
              d.vel.z += 1.5 * vn * s * sx;
            }
          } else {
            const sz = Math.sign(lz) || 1;
            m.position.x += s * sz * oz;
            m.position.z += c * sz * oz;
            const vn = (d.vel.x * s + d.vel.z * c) * sz;
            if (vn < 0) {
              d.vel.x -= 1.5 * vn * s * sz;
              d.vel.z -= 1.5 * vn * c * sz;
            }
          }
        }
      }
      if (arenaSDF(m.position.x, m.position.z) > -0.3) {
        arenaNormal(m.position.x, m.position.z, _v1);
        const vn = d.vel.x * _v1.x + d.vel.z * _v1.z;
        if (vn > 0) {
          d.vel.x -= 1.5 * vn * _v1.x;
          d.vel.z -= 1.5 * vn * _v1.z;
        }
      }
      const sp = d.spin.length();
      if (sp > 0.01) {
        _q1.setFromAxisAngle(_v2.copy(d.spin).divideScalar(sp), sp * dt);
        m.quaternion.premultiply(_q1);
      }
    }
    // cars kick debris around: light bits fly, logs get bulldozed along by the bumper, or a fast car
    // goes over them with a bump and they spin out from underneath
    for (const car of G.cars) {
      const dx = m.position.x - car.pos.x,
        dz = m.position.z - car.pos.z;
      if (dx * dx + dz * dz > 12 || m.position.y > car.pos.y + 1.4) continue;
      const sy = Math.sin(car.yaw),
        cy = Math.cos(car.yaw),
        lf = dx * sy + dz * cy,
        ll = dx * cy - dz * sy,
        pad = d.r * 0.4;
      if (Math.abs(lf) > CARDIM.hl + pad || Math.abs(ll) > CARDIM.hw + pad) continue;
      const sp = Math.hypot(car.vel.x, car.vel.z);
      if (sp < (d.heavy ? 1.2 : 3)) continue;
      d.still = false;
      d.lying = false;
      const k = 1 / (Math.hypot(dx, dz) || 1);
      if (!d.heavy) {
        d.vel.set(car.vel.x * 1.1 + dx * 2, Math.min(6, sp * 0.3), car.vel.z * 1.1 + dz * 2);
        d.spin.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
        if (Math.random() < 0.3) SFX.clank(m.position);
      } else if (sp > 9 && car.grounded) {
        const side = ll >= 0 ? 1 : -1;
        d.vel.set(
          car.vel.x * 0.35 + cy * side * rand(2, 4),
          rand(1.5, 3),
          car.vel.z * 0.35 - sy * side * rand(2, 4),
        );
        d.spin.set(rand(-9, 9), rand(-4, 4), rand(-9, 9));
        if (G.time - d.bumpT > 0.4) {
          d.bumpT = G.time;
          car.vel.y += Math.min(3.2, 1.2 + sp * 0.1);
          car.grounded = false; // up and over: a 20-30 cm hop
          car.vel.x *= 0.97;
          car.vel.z *= 0.97;
          shakeCarCrew(car, 0.12);
          SFX.thud(m.position);
        }
      } else {
        d.vel.set(
          car.vel.x * rand(1, 1.15) + dx * k * 1.5,
          Math.min(2.5, 0.6 + sp * 0.12),
          car.vel.z * rand(1, 1.15) + dz * k * 1.5,
        );
        d.spin.set(rand(-4, 4), rand(-3, 3), rand(-4, 4));
        const drag = Math.pow(0.99, dt * 60); // (the same per second at any frame rate)
        car.vel.x *= drag;
        car.vel.z *= drag;
        if (G.time - d.bumpT > 0.5) {
          d.bumpT = G.time;
          SFX.thud(m.position);
        }
      }
    }
    if (d.life < 0) {
      // keep the most recent parts as wreckage; fade out older ones by sinking them
      m.position.y -= dt * 0.25;
      if (d.life < -4) {
        removeDebris(d);
        G.debris.splice(i, 1);
      }
    }
  }
}

// =====================================================================
//  Nitro: a roaring flame out of the exhaust (out of the side pipes on the muscle car): blue at the
//  root, white-hot, orange at the tip, flickering and spitting sparks. It bursts out when the nitro hits.
// =====================================================================
const FLAME_GEO = new THREE.ConeGeometry(1, 1, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5); // root at the pipe, tip behind
const FLAME_MAT = [0xff5a14, 0xffc870, 0x8fc4ff].map(
  (color, k) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: requireValue([0.8, 0.85, 0.95][k]),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
);
const FLAME_LAYER: [number, number][] = [
  [0.27, 1],
  [0.18, 0.7],
  [0.1, 0.38],
]; // outer flame, hot middle, blue core: radius, length
const EXHAUSTS = {
  std: [
    [0.42, 0.3, -CARDIM.hl - 0.05],
    [-0.42, 0.3, -CARDIM.hl - 0.05],
  ] as [number, number, number][],
};
const _fl = new THREE.Vector3();
export function nitroFlame(car: Car, dt: number) {
  const on = car.boosting && car.alive;
  if (!car.flames) {
    if (!on) return;
    const own = car.cfg && KIT_EXHAUSTS[car.cfg.kit]; // a kit may have its own pipes (the muscle car's out of the sides)
    car.flames = (own || EXHAUSTS.std).map(([x, y, z]) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      if (own) {
        // out of the side pipes, fanning out a little; none from a pipe that has been knocked off
        g.rotation.y = -Math.sign(x) * 0.25;
        g.userData['pipe'] = car.kit.find((p) => p.zone === (x > 0 ? 'left' : 'right'));
      }
      FLAME_MAT.forEach((m, k) => {
        const c = new THREE.Mesh(FLAME_GEO, m);
        c.scale.set(
          requireValue(requireValue(FLAME_LAYER[k])[0]),
          requireValue(requireValue(FLAME_LAYER[k])[0]),
          requireValue(FLAME_LAYER[k])[1],
        );
        c.renderOrder = 3;
        g.add(c);
      });
      car.body.add(g);
      return g;
    });
    car.flameT = 0;
  }
  const start = on && car.flameT === 0;
  car.flameT = on ? (car.flameT ?? 0) + dt : 0;
  const K = car.spec ? car.spec.nitro : 1,
    burst = Math.max(0, 1 - car.flameT * 4) * 0.9,
    t = performance.now() / 1000;
  car.flames.forEach((g, i: number) => {
    g.visible = on && !(g.userData['pipe'] && g.userData['pipe'].gone);
    if (!g.visible) return;
    const len = (1.9 + 0.45 * Math.sin(t * 47 + i * 2) + rand(-0.35, 0.35) + burst * 2.2) * (0.8 + 0.3 * K);
    const wid = 1 + burst * 0.7 + rand(-0.15, 0.15);
    g.scale.set(wid, wid, len);
  });
  if (!on) return;
  if (start) {
    car.body.updateWorldMatrix(true, true);
    SFX.nitro(requireValue(car.flames[0]).getWorldPosition(_fl));
  }
  // sparks and embers off the tips
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  for (const g of car.flames) {
    if (!g.visible || Math.random() > dt * (start ? 200 : 26)) continue;
    g.getWorldPosition(_fl);
    GLOW.emit({
      x: _fl.x - sy * 0.9,
      y: _fl.y,
      z: _fl.z - cy * 0.9,
      vx: car.vel.x - sy * rand(6, 10) + rand(-1.2, 1.2),
      vy: rand(0, 1.6),
      vz: car.vel.z - cy * rand(6, 10) + rand(-1.2, 1.2),
      life: rand(0.2, 0.4),
      s0: rand(0.12, 0.24),
      s1: 0.03,
      c0: pick([
        [1, 0.85, 0.45, 1],
        [0.6, 0.8, 1, 1],
      ]),
      c1: [1, 0.3, 0.05, 0],
      grav: 4,
    });
  }
}
