import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo } from './mesh-geometry.ts';

interface InteriorMaterials {
  structure: THREE.Material;
  seats: THREE.Material;
  metal: THREE.Material;
}

let interiorGeometry: readonly THREE.BufferGeometry[] | null = null;
let crewGeometry: THREE.BufferGeometry | null = null;

/** Merge once for every car. The chassis keeps these shared pieces when its outer panels leave. */
function mergeBoxes(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function interior(): readonly THREE.BufferGeometry[] {
  if (interiorGeometry) return interiorGeometry;
  const structure = [
    boxGeo(1.45, 0.09, 2.45, 0, 0.32, -0.25), // solid cabin floor
    boxGeo(1.45, 0.48, 0.08, 0, 0.59, 0.91), // firewall behind the engine
    boxGeo(0.22, 0.2, 2.25, 0, 0.43, -0.25), // transmission tunnel
    boxGeo(1.45, 0.12, 0.18, 0, 0.82, 0.77), // dashboard lower edge
    boxGeo(1.4, 0.12, 0.12, 0, 0.46, 2.02), // engine cradle
  ];
  const seats: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [
    boxGeo(0.58, 0.29, 0.62, 0, 0.61, 1.49), // engine block
    boxGeo(0.42, 0.09, 0.5, 0, 0.8, 1.49), // cylinder cover
    boxGeo(1.04, 0.34, 0.08, 0, 0.62, 1.95), // radiator
    boxGeo(1.4, 0.07, 0.09, 0, 0.69, 1.08), // rear engine-bay brace
    boxGeo(1.35, 0.08, 0.8, 0, 0.47, -1.75), // trunk floor
  ];
  for (const side of [-1, 1]) {
    structure.push(boxGeo(0.1, 0.16, 2.45, side * 0.72, 0.39, -0.25)); // exposed door sills
    metal.push(boxGeo(0.09, 0.15, 0.91, side * 0.59, 0.5, 1.49)); // chassis rails
    for (const z of [0.02, -0.85]) {
      seats.push(
        boxGeo(0.49, 0.12, 0.46, side * 0.4, 0.55, z - 0.02),
        boxGeo(0.49, 0.45, 0.11, side * 0.4, 0.78, z - 0.23, -0.12),
      );
    }
  }
  interiorGeometry = [mergeBoxes(structure), mergeBoxes(seats), mergeBoxes(metal)];
  for (const geometry of interiorGeometry)
    geometry.setAttribute('aCar', geometry.getAttribute('position').clone());
  return interiorGeometry;
}

/** Three opaque draws, no new textures or per-frame work; materials and geometry stay caller/shared owned. */
export function buildCarInterior(materials: InteriorMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'car-interior';
  const mats = [materials.structure, materials.seats, materials.metal];
  interior().forEach((geometry, i) => {
    const material = mats[i];
    if (!material) throw new Error('Missing car interior material');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = ['cabin-structure', 'seat-cushions', 'engine-and-frame'][i] ?? 'interior';
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
}

/** Seated, fully clothed crew: legs and boots remain visible through a missing door. */
export function buildCrewGeometry(): THREE.BufferGeometry {
  if (crewGeometry) return crewGeometry;
  function paint(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
    const linear = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([linear.r, linear.g, linear.b], i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }
  const suit = 0x61616b;
  const parts = [
    paint(boxGeo(0.4, 0.5, 0.26, 0, -0.3, -0.04), suit),
    paint(new THREE.SphereGeometry(0.155, 14, 10).scale(1, 1.05, 1.1).translate(0, 0.02, 0), 0xffffff),
    paint(boxGeo(0.22, 0.08, 0.06, 0, 0.02, 0.14), 0x101214),
  ];
  for (const side of [-1, 1]) {
    parts.push(
      paint(boxGeo(0.1, 0.1, 0.38, side * 0.17, -0.2, 0.16, 0.45), suit),
      paint(boxGeo(0.16, 0.15, 0.34, side * 0.11, -0.56, 0.11), suit),
      paint(boxGeo(0.13, 0.2, 0.14, side * 0.11, -0.6, 0.28, -0.1), suit),
      paint(boxGeo(0.15, 0.1, 0.26, side * 0.11, -0.68, 0.35), 0x181a1d),
    );
  }
  crewGeometry = mergeBoxes(parts);
  return crewGeometry;
}
