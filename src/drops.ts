import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import { DROP_KINDS, isDropKind, type DropKind } from './gameplay/supplies.ts';
import { DROP_TYPES } from './drop-data.ts';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SHARED, pick, rand } from './core.ts';
import { SURFACE, arenaSDF, canvasTexture, scene, spotClear, surfaceGrip } from './world.ts';
import { bumperShare } from './car.ts';
import { G } from './state.ts';
import { boxGeo } from './mesh-geometry.ts';
import { GLOW } from './fx.ts';
import {} from './audio.ts';
import { cssRgb } from './paint.ts';
import { STOCK_MAX } from './mechanic-data.ts';
import { FX, share } from './net/effects.ts';
import { isReplica } from './net/role.ts';
import { NOTES, noteFx } from './sharedfx.ts';
import { D } from './data.ts';
import { DROP_PADS, TOWN } from './arena-state.ts';
import { insidePoly } from './town/geometry.ts';

// =====================================================================
//  Supply drops: fuel cans, spare tyres, rubber bumpers and windscreens turn up at random spots on the tarmac.
//  Drive over one to pick it up: it goes into the car's spares, for the mechanic. With those full, it stays where it is.
// =====================================================================
const DROP = D.drops; // how many, how often, how close (data/drops.json)
// what each is, and where it goes in the spares (how many, and what the crew are told); colours and letters from data/drops.json
const roomFor = (car: Car, type: DropKind) =>
  car.stock[DROP_TYPES[type].stock] < STOCK_MAX[DROP_TYPES[type].stock];
const DROP_ASSETS = (() => {
  const beamTex = canvasTexture(4, 128, (g, w: number, h: number) => {
    const grd = g.createLinearGradient(0, h, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  beamTex.wrapS = beamTex.wrapT = THREE.ClampToEdgeWrapping;
  return {
    beamGeo: new THREE.CylinderGeometry(0.32, 0.32, 9, 14, 1, true).translate(0, 4.5, 0),
    ringGeo: new THREE.RingGeometry(1.05, 1.32, 36).rotateX(-Math.PI / 2),
    beamTex,
    can: mergeGeometries([
      boxGeo(0.36, 0.48, 0.15),
      boxGeo(0.2, 0.05, 0.05, -0.04, 0.29, 0),
      boxGeo(0.05, 0.14, 0.05, 0.13, 0.28, 0, 0, 0, -0.5),
    ]),
    canMat: new THREE.MeshStandardMaterial({ color: 0xc8261c, roughness: 0.4, metalness: 0.3 }),
    tyre: new THREE.TorusGeometry(0.3, 0.12, 10, 22),
    tyreMat: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.85 }),
    rim: new THREE.CylinderGeometry(0.2, 0.2, 0.16, 16).rotateX(Math.PI / 2),
    rimMat: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.8 }),
    bumper: new THREE.TorusGeometry(0.34, 0.1, 10, 20, Math.PI * 1.2),
    rubberMat: new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.82 }),
    pane: new THREE.BoxGeometry(0.92, 0.5, 0.025),
    paneMat: new THREE.MeshStandardMaterial({
      color: 0x9fd8ee,
      transparent: true,
      opacity: 0.5,
      roughness: 0.05,
      metalness: 0.3,
    }),
    paneFrame: mergeGeometries([
      boxGeo(0.98, 0.05, 0.05, 0, 0.27, 0),
      boxGeo(0.98, 0.05, 0.05, 0, -0.27, 0),
      boxGeo(0.05, 0.5, 0.05, 0.47, 0, 0),
      boxGeo(0.05, 0.5, 0.05, -0.47, 0, 0),
    ]),
  };
})();

function buildDropMesh(type: DropKind) {
  const T = DROP_TYPES[type],
    A = DROP_ASSETS;
  const root = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({
    color: T.color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(A.ringGeo, glow);
  ring.position.y = 0.04;
  const beam = new THREE.Mesh(
    A.beamGeo,
    new THREE.MeshBasicMaterial({
      color: T.color,
      map: A.beamTex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  const item = new THREE.Group();
  item.position.y = 1;
  if (type === 'fuel') item.add(new THREE.Mesh(A.can, A.canMat));
  else if (type === 'tyre') {
    item.add(new THREE.Mesh(A.tyre, A.tyreMat), new THREE.Mesh(A.rim, A.rimMat));
  } else if (type === 'bumper') {
    const b = new THREE.Mesh(A.bumper, A.rubberMat);
    b.rotation.z = -0.3;
    item.add(b);
  } else {
    item.add(new THREE.Mesh(A.pane, A.paneMat), new THREE.Mesh(A.paneFrame, SHARED.darkMetal));
  }
  item.traverse((o) => {
    o.castShadow = true;
  });
  root.add(ring, beam, item);
  return { root, ring, beam, item, mats: [glow, beam.material] };
}

// Where a drop of this kind may land: on a free drop pad when the town has pads, else anywhere paved,
// inside the town's drops zones (if it has any) and outside its noDrops zones, clear of everything.
function dropSpot(type: DropKind) {
  const S = SURFACE,
    keep = DROP.keep;
  const free = (x: number, z: number) =>
    !G.cars.some((c) => Math.hypot(c.pos.x - x, c.pos.z - z) < keep.cars) &&
    !G.drops.some((d) => d.taken < 0 && Math.hypot(d.x - x, d.z - z) < keep.drops);
  if (DROP_PADS.length) {
    const pads = DROP_PADS.filter((p) => (!p.types || p.types.includes(type)) && free(p.x, p.z));
    return pads.length ? pick(pads) : null;
  }
  const zones = TOWN?.zones ?? [],
    yes = zones.filter((zn) => zn.kind === 'drops'),
    no = zones.filter((zn) => zn.kind === 'noDrops');
  for (let tries = 0; tries < 400; tries++) {
    const x = rand(S.x0, S.x0 + S.w),
      z = rand(S.z0, S.z0 + S.h);
    if (
      surfaceGrip(x, z) < 1 ||
      arenaSDF(x, z) > -keep.edge ||
      !spotClear(x, z, keep.obstacles) ||
      !free(x, z)
    )
      continue;
    if (
      (yes.length && !yes.some((zn) => insidePoly(x, z, zn.poly))) ||
      no.some((zn) => insidePoly(x, z, zn.poly))
    )
      continue;
    return { x, z };
  }
  return null;
}

export function spawnDrop() {
  // keep a mix: one of the kinds the map has fewest of
  const have = { fuel: 0, tyre: 0, bumper: 0, glass: 0 };
  for (const d of G.drops) have[d.type]++;
  const fewest = Math.min(...Object.values(have)),
    type = pick(DROP_KINDS.filter((k) => have[k] === fewest));
  const spot = dropSpot(type);
  if (!spot) return;
  G.dropSeq = (G.dropSeq || 0) + 1;
  placeDrop(G.dropSeq, type, spot.x, spot.z, rand(0, 5));
}

// A drop appears (on every screen: the host picks where and what).
export function placeDrop(id: number, type: DropKind, x: number, z: number, t: number) {
  if (share(FX.placeDrop, placeDrop, [id, type, x, z, t])) return;
  if (!isDropKind(type)) throw new Error('Unknown supply drop');
  const m = buildDropMesh(type);
  m.root.position.set(x, 0, z);
  scene.add(m.root);
  G.drops.push({ id, type, x, z, m, t, taken: -1 });
}

// Someone drove over it: it shoots up in a burst of its colour.
export function takeDrop(id: number) {
  if (share(FX.takeDrop, takeDrop, [id])) return;
  const d = G.drops.find((e) => e.id === id && e.taken < 0);
  if (!d) return;
  d.taken = 0;
  const [r, g, b] = cssRgb(DROP_TYPES[d.type].ui);
  for (let k = 0; k < 24; k++)
    GLOW.emit({
      x: d.x,
      y: 1,
      z: d.z,
      vx: rand(-3, 3),
      vy: rand(2, 6),
      vz: rand(-3, 3),
      life: rand(0.4, 0.8),
      s0: 0.22,
      s1: 0.04,
      c0: [r, g, b, 1],
      c1: [r, g, b, 0],
      grav: 6,
    });
}

export function clearDrops() {
  for (const d of G.drops) {
    scene.remove(d.m.root);
    d.m.mats.forEach((m) => m.dispose());
  }
  G.drops = [];
  G.dropT = 0;
  G.dropsSeeded = -1;
}

// What a drop does for a car: it goes into the spares.
export function giveDrop(car: Car, type: DropKind) {
  const T = DROP_TYPES[type];
  car.stock[T.stock] = Math.min(STOCK_MAX[T.stock], car.stock[T.stock] + T.n);
  noteFx(
    car,
    NOTES.findIndex(([text]) => text === T.note),
  );
}

// A line in the corner of everybody sitting in this car.
export function updateDrops(dt: number) {
  const playing = G.state === 'playing' || G.state === 'countdown';
  const host = !isReplica(); // the host's game places and hands out the drops; the others only draw them
  if (playing && host) {
    if (G.dropsSeeded !== G.round) {
      G.dropsSeeded = G.round;
      for (let i = 0; i < DROP.atStart; i++) spawnDrop();
      G.dropT = rand(requireValue(DROP.every[0]), requireValue(DROP.every[1]));
    }
    G.dropT -= dt;
    if (G.dropT <= 0) {
      G.dropT = rand(requireValue(DROP.every[0]), requireValue(DROP.every[1]));
      if (G.drops.filter((d) => d.taken < 0).length < DROP.max) spawnDrop();
    }
  }
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = requireValue(G.drops[i]),
      m = d.m;
    d.t += dt;
    if (d.taken >= 0) {
      // picked up: the item shoots up and shrinks, the light fades
      d.taken += dt;
      const f = d.taken / 0.4;
      m.item.position.y = 1 + f * 2.5;
      m.item.scale.setScalar(Math.max(0.01, 1 - f));
      m.mats.forEach((mt) => {
        mt.opacity = Math.max(0, 0.85 * (1 - f));
      });
      if (f >= 1) {
        scene.remove(m.root);
        m.mats.forEach((mt) => mt.dispose());
        G.drops.splice(i, 1);
      }
      continue;
    }
    m.item.position.y = 1 + Math.sin(d.t * 2.4) * 0.12;
    m.item.rotation.y = d.t * 1.6;
    m.ring.scale.setScalar(1 + Math.sin(d.t * 4) * 0.06);
    requireValue(m.mats[0]).opacity = 0.6 + Math.sin(d.t * 4) * 0.25;
    if (G.state !== 'playing' || !host) continue;
    for (const car of G.cars) {
      if (!car.alive || car.pos.y > 2 || !roomFor(car, d.type)) continue;
      if (Math.hypot(car.pos.x - d.x, car.pos.z - d.z) > DROP.reach) continue;
      takeDrop(d.id);
      giveDrop(car, d.type);
      break;
    }
  }
}

// Which drop is this car (driven by a bot) after? Spares it has run out of first, anything close by otherwise
// (nothing it has no room for).
export function dropWanted(car: Car) {
  const s = car.sys,
    st = car.stock;
  const need = {
    fuel: !st.fuel || s.fuel < 15,
    tyre: !st.tyres,
    bumper: bumperShare(car) < 0.6 && st.bumpers < 2,
    glass: car.glass.shield.crack.level > 0.45 && !st.glass,
  };
  let best = null,
    bestD = Infinity;
  for (const d of G.drops) {
    if (d.taken >= 0 || !roomFor(car, d.type)) continue;
    const dist = Math.hypot(d.x - car.pos.x, d.z - car.pos.z);
    const score = need[d.type] ? dist : dist < 12 ? dist + 40 : Infinity;
    if (score < bestD && dist < 75) {
      bestD = score;
      best = d;
    }
  }
  return best;
}
