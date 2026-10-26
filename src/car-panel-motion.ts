import * as THREE from 'three';
import {
  BODY_PANELS,
  type BodyPanel,
  type BodyworkState,
  type BodyDamageTuning,
} from './gameplay/body-damage.ts';

type PanelMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
type MotionTuning = Pick<BodyDamageTuning, 'panelLooseDamage' | 'panelDamage'>;
export interface CarPanelMotion {
  update(bodywork: BodyworkState, time: number, speed: number, dt: number): void;
  /** Shared dents use canonical car space, independent of each screen's animation interpolation. */
  restPosition(mesh: THREE.Object3D): Readonly<THREE.Vector3>;
}

/** Geometry is read once. The hinge follows the foremost door edge or the lid edge near the cabin. */
function hingeFor(mesh: PanelMesh, panel: BodyPanel): THREE.Vector3 {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) throw new Error('A car panel needs bounds');
  const rearHinge = panel === 'car_hood';
  const edge = rearHinge ? bounds.min.z : bounds.max.z;
  const strip = Math.max(0.015, (bounds.max.z - bounds.min.z) * 0.02);
  const positions = geometry.getAttribute('position');
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    if (Math.abs(positions.getZ(i) - edge) > strip) continue;
    minX = Math.min(minX, positions.getX(i));
    maxX = Math.max(maxX, positions.getX(i));
    minY = Math.min(minY, positions.getY(i));
    maxY = Math.max(maxY, positions.getY(i));
  }
  return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, edge);
}

/** Six existing transforms per car: no geometry changes, new draws, randomness, or frame allocations. */
export function createCarPanelMotion(
  parts: Readonly<Partial<Record<BodyPanel, PanelMesh>>>,
  tuning: MotionTuning,
): CarPanelMotion {
  const panels = BODY_PANELS.flatMap((panel, index) => {
    const mesh = parts[panel];
    if (!mesh) return [];
    const hinge = hingeFor(mesh, panel);
    const restQuaternion = mesh.quaternion.clone();
    return [
      {
        panel,
        mesh,
        parent: mesh.parent,
        hinge,
        restQuaternion,
        restPosition: mesh.position.clone(),
        anchor: hinge.clone().applyQuaternion(restQuaternion).add(mesh.position),
        offset: new THREE.Vector3(),
        rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
        quaternion: new THREE.Quaternion(),
        phase: index * 1.37,
        x: 0,
        y: 0,
        z: 0,
      },
    ];
  });
  const restPositions = new Map<THREE.Object3D, THREE.Vector3>();
  for (const state of panels) restPositions.set(state.mesh, state.restPosition);
  return {
    restPosition(mesh) {
      return restPositions.get(mesh) ?? mesh.position;
    },
    update(bodywork, time, speed, dt) {
      if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(time) || time < 0) return;
      const blend = 1 - Math.exp(-12 * Math.min(dt, 0.1));
      const wind = Number.isFinite(speed) ? Math.min(1, Math.abs(speed) / 28) : 0;
      for (const state of panels) {
        const { mesh, panel } = state;
        // A detached mesh belongs to debris now; never overwrite its flight pose.
        if (!state.parent || mesh.parent !== state.parent || parts[panel] !== mesh) continue;
        const damage = bodywork[panel];
        let x = 0;
        let y = 0;
        let z = 0;
        if (damage.looseSince !== null && time >= damage.looseSince && Number.isFinite(damage.wear)) {
          const span = Math.max(0.001, tuning.panelDamage - tuning.panelLooseDamage);
          const wear = Math.max(0, Math.min(1, (damage.wear - tuning.panelLooseDamage) / span));
          const severity = 0.4 + wear * 0.6;
          const wave = Math.sin(time * (5.4 + wind * 3) + state.phase);
          if (panel === 'car_hood' || panel === 'trunk') {
            const sign = panel === 'car_hood' ? -1 : 1;
            x = sign * severity * (0.24 + wind * 0.17 + wave * (0.12 + wind * 0.08));
          } else {
            const side = panel.startsWith('L_') ? 1 : -1;
            x = -severity * (0.05 + 0.025 * wave);
            y = -side * severity * (0.57 + wind * 0.14 + wave * 0.22);
            z = side * severity * 0.035;
          }
        }
        state.x += (x - state.x) * blend;
        state.y += (y - state.y) * blend;
        state.z += (z - state.z) * blend;
        // Intact panels cost no matrix updates after settling back into their original pose.
        if (Math.abs(state.x) + Math.abs(state.y) + Math.abs(state.z) < 0.000001) {
          if (state.x || state.y || state.z) {
            mesh.position.copy(state.restPosition);
            mesh.quaternion.copy(state.restQuaternion);
          }
          state.x = state.y = state.z = 0;
          continue;
        }
        state.rotation.set(state.x, state.y, state.z);
        state.quaternion.setFromEuler(state.rotation);
        mesh.quaternion.copy(state.restQuaternion).multiply(state.quaternion);
        state.offset.copy(state.hinge).applyQuaternion(mesh.quaternion);
        mesh.position.copy(state.anchor).sub(state.offset);
      }
    },
  };
}
