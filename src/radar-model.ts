import type { Car } from './car-types.ts';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CARDIM, SHARED, TAU, rand } from './core.ts';
import { boxGeo } from './mesh-geometry.ts';
import { D, onData } from './data.ts';

export const RADAR = { z: -0.62, headY: 0.22, period: 1.6, range: 70, hp: 26, hitR: 0.28 };
onData(() => Object.assign(RADAR, D.car.radar)); // how fast it turns, how far it sees, how much it takes (data/car.json); where it sits is the model's

const RADAR_GEO = {
  base: new THREE.CylinderGeometry(0.1, 0.12, 0.05, 14).translate(0, 0.025, 0),
  stem: new THREE.CylinderGeometry(0.022, 0.026, RADAR.headY, 8).translate(0, RADAR.headY / 2, 0),
  // the rotating head: antenna bar (group 0), team-colour face (group 1), lamp (group 2)
  head: (() => {
    const g = mergeGeometries(
      [
        mergeGeometries([boxGeo(0.58, 0.07, 0.04), boxGeo(0.07, 0.05, 0.08, 0, -0.045, -0.02)]),
        boxGeo(0.52, 0.042, 0.008, 0, 0, 0.024),
        new THREE.SphereGeometry(0.024, 8, 6).translate(0, 0.05, -0.01),
      ].map((x) => x.toNonIndexed()),
      true,
    );
    g.computeBoundingSphere();
    return g;
  })(),
};
const RADAR_LAMP = new THREE.MeshBasicMaterial({ color: 0x5bff9a, toneMapped: false });

export function buildRadar(car: Pick<Car, 'body' | 'ballMat' | 'yaw'>): Car['radar'] {
  const rig = new THREE.Group();
  rig.position.set(0, CARDIM.top, RADAR.z);
  const base = new THREE.Mesh(RADAR_GEO.base, SHARED.darkMetal);
  const stem = new THREE.Mesh(RADAR_GEO.stem, SHARED.gunMetal);
  rig.add(base, stem);
  for (const m of [base, stem]) m.castShadow = true;
  car.body.add(rig);
  const radar: Car['radar'] = {
    rig,
    stem,
    head: null,
    local: rand(0, TAU),
    world: 0,
    hp: RADAR.hp,
    destroyed: false,
    contacts: new Map(),
    drops: new Map(),
    sparkT: 0,
  };
  fitRadarHead({ ...car, radar });
  return radar;
}
export function fitRadarHead(car: Pick<Car, 'radar' | 'ballMat' | 'yaw'>) {
  const R = car.radar;
  R.head = new THREE.Mesh(RADAR_GEO.head, [SHARED.darkMetal, car.ballMat, RADAR_LAMP]);
  R.head.position.y = RADAR.headY;
  R.head.castShadow = true;
  R.rig.add(R.head);
  R.stem.rotation.set(0, 0, 0);
  R.hp = RADAR.hp;
  R.destroyed = false;
  R.world = car.yaw + R.local;
}
