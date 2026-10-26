import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEAMS, rand } from './core.ts';
import { CAR_SPECS, KITS, isKit } from './kit-data.ts';
import { boxGeo } from './mesh-geometry.ts';
import { addDebris } from './fx.ts';
import { SFX } from './audio.ts';

// =====================================================================
//  The cars: the same body, built up with a mod kit (data/kits.json), and each drives its own way.
//  Each add-on part sits in a damage zone and flies off when that side takes enough of a beating
//  (and most of them go when the car is out). The kits that ship:
//    rally  - light bar with four spot lamps, roof scoop, mud flaps, skid plate
//    drift  - big GT wing, canards, fender flares, diffuser
//    sport  - splitter, side skirts, lip spoiler, tow hook
//    muscle - supercharger blower through the hood, side pipes, ducktail spoiler
// =====================================================================
const KIT_MAT = {
  black: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.6, metalness: 0.2 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x232529, roughness: 0.3, metalness: 0.4 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.12, metalness: 1 }),
  alu: new THREE.MeshStandardMaterial({ color: 0xaab0b6, roughness: 0.35, metalness: 0.85 }),
  red: new THREE.MeshStandardMaterial({ color: 0xd42a1e, roughness: 0.5 }),
  lens: new THREE.MeshStandardMaterial({
    color: 0xfff6d8,
    emissive: 0xffe9b0,
    emissiveIntensity: 0.6,
    roughness: 0.1,
  }),
};
const kitGeo = (() => {
  const cache: Partial<Record<string, THREE.BufferGeometry>> = {};
  const make = {
    bar: () => boxGeo(1.25, 0.05, 0.06),
    spot: () =>
      mergeGeometries([
        new THREE.CylinderGeometry(0.085, 0.095, 0.09, 14).rotateX(Math.PI / 2),
        boxGeo(0.03, 0.08, 0.03, 0, -0.07, -0.02),
      ]),
    lensDisc: () =>
      new THREE.CylinderGeometry(0.074, 0.074, 0.01, 14).rotateX(Math.PI / 2).translate(0, 0, 0.047),
    scoop: () => mergeGeometries([boxGeo(0.46, 0.08, 0.34), boxGeo(0.36, 0.05, 0.02, 0, 0.005, 0.17)]),
    flap: () => boxGeo(0.26, 0.32, 0.015),
    skid: () => boxGeo(1.1, 0.03, 0.42),
    wingPost: () => boxGeo(0.04, 0.5, 0.14),
    wing: () => boxGeo(1.62, 0.035, 0.34, 0, 0, 0, -0.08),
    endplate: () => boxGeo(0.02, 0.17, 0.4),
    canard: () => boxGeo(0.22, 0.02, 0.15, 0, 0, 0, 0, 0, 0.3),
    flare: () => boxGeo(0.07, 0.13, 0.82),
    diffuser: () =>
      mergeGeometries([
        boxGeo(1.1, 0.03, 0.32),
        ...[-0.4, -0.13, 0.13, 0.4].map((x) => boxGeo(0.02, 0.12, 0.3, x, 0.06, 0)),
      ]),
    splitter: () => boxGeo(1.7, 0.025, 0.28),
    skirt: () => boxGeo(0.05, 0.1, 2.3),
    lip: () => boxGeo(1.3, 0.05, 0.14, 0, 0, 0, -0.3),
    hook: () => new THREE.TorusGeometry(0.06, 0.016, 6, 14).rotateY(Math.PI / 2),
    fin: () => boxGeo(0.03, 0.1, 0.24, 0, 0, 0, -0.35),
    blower: () =>
      mergeGeometries([
        boxGeo(0.4, 0.13, 0.34),
        new THREE.CylinderGeometry(0.07, 0.07, 0.42, 10).rotateZ(Math.PI / 2).translate(0, 0.08, 0.12),
      ]),
    blowerScoop: () => boxGeo(0.34, 0.11, 0.26),
    pipe: () =>
      mergeGeometries([
        new THREE.CylinderGeometry(0.055, 0.055, 1.7, 12).rotateX(Math.PI / 2),
        new THREE.CylinderGeometry(0.065, 0.065, 0.05, 12).rotateX(Math.PI / 2).translate(0, 0, -0.85),
      ]),
    duck: () => boxGeo(1.36, 0.07, 0.24, 0, 0, 0, -0.28),
  };
  return (k: string): THREE.BufferGeometry => {
    if (!Object.hasOwn(make, k)) throw new Error(`Unknown kit shape: ${k}`);
    const shape = k as keyof typeof make;
    return cache[k] ?? (cache[k] = make[shape]());
  };
})();

export function buildKit(car: Pick<Car, 'mass' | 'inertia' | 'body' | 'team'>, kit: string) {
  if (!isKit(kit)) kit = 'stock';
  const kitParts: NonNullable<Car['kit']> = [];
  const spec = requireValue(CAR_SPECS[kit]);
  car.mass *= spec.mass;
  car.inertia *= spec.mass;
  const def = requireValue(KITS[kit]);
  if (!def.length) return { kit: kitParts, spec };
  const kitMat = new THREE.MeshStandardMaterial({
    color: requireValue(TEAMS[car.team]).color,
    roughness: 0.35,
    metalness: 0.3,
  });
  for (const [zone, hp, pos, ...pieces] of def) {
    const group = new THREE.Group();
    group.position.fromArray(pos);
    for (const [geo, mat, off] of pieces) {
      const m = new THREE.Mesh(kitGeo(geo), mat === 'team' ? kitMat : KIT_MAT[mat as keyof typeof KIT_MAT]);
      m.position.fromArray(off);
      m.castShadow = true;
      group.add(m);
    }
    car.body.add(group);
    kitParts.push({ zone, hp, group, gone: false });
  }
  return { kit: kitParts, spec, kitMat };
}

const KIT_ZONE = { left: ['lf', 'lr'], right: ['rf', 'rr'] };
// A hit in a zone wears down the parts there; the roof bits get a share of every hit.
export function kitHit(car: Car, zone: import('./gameplay/geometry.ts').DamageZone, amount: number) {
  for (const p of car.kit) {
    if (p.gone) continue;
    const here =
      p.zone === zone || ((p.zone === 'left' || p.zone === 'right') && KIT_ZONE[p.zone].includes(zone));
    const share = here ? 1 : p.zone === 'top' ? 0.3 : 0;
    if (!share) continue;
    p.hp -= amount * share;
    if (p.hp <= 0) detachKit(car, p);
  }
}

export function detachKit(car: Car, p: Car['kit'][number], boost = 1) {
  if (p.gone) return;
  p.gone = true;
  p.group.updateWorldMatrix(true, false);
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion();
  p.group.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  p.group.removeFromParent();
  const out = pos.clone().sub(car.pos).setY(0).normalize();
  const vel = car.vel
    .clone()
    .multiplyScalar(0.5)
    .addScaledVector(out, rand(2.5, 5) * boost);
  vel.y = rand(3, 6) * boost;
  addDebris(p.group, pos, quat, vel, 10);
  SFX.clank(pos);
}
