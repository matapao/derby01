import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCarInterior, buildCrewGeometry } from '../src/car-interior.ts';

type InteriorMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
function interior(t: TestContext) {
  const materials = {
    structure: new THREE.MeshStandardMaterial(),
    seats: new THREE.MeshStandardMaterial(),
    metal: new THREE.MeshStandardMaterial(),
  };
  t.after(() => {
    for (const material of Object.values(materials)) material.dispose();
  });
  const group = buildCarInterior(materials);
  group.updateMatrixWorld(true);
  return { group, materials };
}
function meshes(group: THREE.Object3D): InteriorMesh[] {
  const result: InteriorMesh[] = [];
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) result.push(node);
  });
  return result;
}
function ray(group: THREE.Object3D, origin: THREE.Vector3, direction: THREE.Vector3) {
  group.updateMatrixWorld(true);
  return new THREE.Raycaster(origin, direction, 0, 3).intersectObject(group, true)[0];
}
function triangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3;
}
function attributeBytes(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.getIndex()?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes +=
      attribute instanceof THREE.InterleavedBufferAttribute
        ? attribute.data.array.byteLength
        : attribute.array.byteLength;
  }
  return bytes;
}

test('exposed footwells have a solid floor beneath all four occupants', (t) => {
  const { group } = interior(t);
  for (const x of [-0.4, 0.4]) {
    for (const z of [0.4, -0.45]) {
      const hit = ray(group, new THREE.Vector3(x, 0.48, z), new THREE.Vector3(0, -1, 0));
      assert.ok(hit, `A missing door must reveal a floor below the feet at ${x}, ${z}`);
      assert.ok(hit.point.y > 0.3 && hit.point.y < 0.4);
    }
  }
  // Low side rays pass below the seats and meet the remaining door sill.
  for (const side of [-1, 1]) {
    const hit = ray(group, new THREE.Vector3(side * 1.2, 0.4, 0.2), new THREE.Vector3(-side, 0, 0));
    assert.ok(hit, 'The exposed cabin retains an outer sill');
    assert.ok(Math.abs(hit.point.x) > 0.65 && Math.abs(hit.point.x) < 0.8);
  }
});

test('a missing hood exposes an engine and firewall rather than a hollow cabin', (t) => {
  const { group } = interior(t);
  for (const x of [-0.4, 0.4]) {
    const hit = ray(group, new THREE.Vector3(x, 0.68, 0.4), new THREE.Vector3(0, 0, 1));
    assert.ok(hit, 'The cabin must be separated from the engine bay');
    assert.ok(hit.point.z > 0.8 && hit.point.z < 1);
  }
  for (const x of [-0.25, 0, 0.25]) {
    const hit = ray(group, new THREE.Vector3(x, 1.2, 1.49), new THREE.Vector3(0, -1, 0));
    assert.ok(hit, 'An opaque engine fills the open hood area');
    assert.ok(hit.point.y > 0.7 && hit.point.y < 0.9);
  }
  const trunk = ray(group, new THREE.Vector3(0.4, 1, -1.75), new THREE.Vector3(0, -1, 0));
  assert.ok(trunk, 'A removed trunk lid reveals a remaining trunk floor');
  assert.ok(trunk.point.y > 0.4 && trunk.point.y < 0.6);
});

test('each occupant has an opaque seat cushion and backrest when the doors are gone', (t) => {
  const { group } = interior(t);
  for (const x of [-0.4, 0.4]) {
    for (const z of [0.02, -0.85]) {
      const cushion = ray(group, new THREE.Vector3(x, 0.7, z), new THREE.Vector3(0, -1, 0));
      assert.ok(cushion, 'The occupant has a seat beneath the torso');
      assert.ok(cushion.point.y > 0.58 && cushion.point.y < 0.65);
      const back = ray(group, new THREE.Vector3(x, 0.85, z + 0.1), new THREE.Vector3(0, 0, -1));
      assert.ok(back, 'The occupant has a backrest behind the torso');
      assert.ok(back.point.z < z - 0.1 && back.point.z > z - 0.35);
    }
  }
});

test('crew have two distinct clothed legs and boots that remain above the floor in every seat', (t) => {
  const { group } = interior(t);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  t.after(() => material.dispose());
  const geometry = buildCrewGeometry();
  const crew = new THREE.Mesh(geometry, material);
  for (const side of [-1, 1]) {
    const thigh = ray(crew, new THREE.Vector3(side * 0.11, -0.4, 0.12), new THREE.Vector3(0, -1, 0));
    const boot = ray(crew, new THREE.Vector3(side * 0.11, -0.55, 0.42), new THREE.Vector3(0, -1, 0));
    assert.ok(thigh && boot, 'Both sides must have real leg and shoe surfaces');
    assert.ok(boot.point.y < -0.6 && boot.point.y > -0.75);
    assert.ok(thigh.face && boot.face);
    const colors = geometry.getAttribute('color');
    assert.ok(colors.getX(boot.face.a) < colors.getX(thigh.face.a), 'Boots are darker than the suit');
  }
  assert.equal(
    ray(crew, new THREE.Vector3(0, -0.55, 0.42), new THREE.Vector3(0, -1, 0)),
    undefined,
    'The two feet must retain a gap instead of forming a flat block',
  );
  const bounds = geometry.boundingBox;
  assert.ok(bounds);
  assert.ok(bounds.min.y < -0.7 && bounds.max.y > 0.15, 'The full body includes feet and helmet');
  for (const [x, anchorY, z] of [
    [0.4, 1.12, 0.02],
    [-0.4, 1.12, 0.02],
    [0.4, 1.1, -0.85],
    [-0.4, 1.1, -0.85],
  ] as const) {
    const floor = ray(group, new THREE.Vector3(x, 0.48, z + 0.4), new THREE.Vector3(0, -1, 0));
    assert.ok(floor);
    assert.ok(anchorY + bounds.min.y >= floor.point.y, 'Even the lowest rear-seat boots clear the floor');
  }
});

test('interior construction shares geometry and reuses only caller-owned materials', (t) => {
  const { group, materials } = interior(t);
  const second = buildCarInterior(materials);
  const firstMeshes = meshes(group);
  const secondMeshes = meshes(second);
  assert.equal(firstMeshes.length, 3, 'The interior adds only three opaque draws per car');
  assert.equal(secondMeshes.length, 3);
  const supplied = new Set<THREE.Material>(Object.values(materials));
  for (const [i, first] of firstMeshes.entries()) {
    const other = secondMeshes[i];
    assert.ok(other);
    assert.notEqual(first, other, 'Each car owns its transforms');
    assert.equal(first.geometry, other.geometry, 'Repeated cars must not duplicate geometry buffers');
    assert.ok(!Array.isArray(first.material) && supplied.has(first.material));
    assert.equal(first.geometry.userData['own'], undefined);
    assert.equal(
      first.geometry.userData['orig'],
      undefined,
      'Car/debris cleanup must not dispose cached geometry',
    );
    const coordinates = first.geometry.getAttribute('aCar');
    const positions = first.geometry.getAttribute('position');
    assert.equal(
      coordinates.count,
      positions.count,
      'Painted materials receive car-local sampling coordinates',
    );
    for (let vertex = 0; vertex < positions.count; vertex++) {
      assert.equal(coordinates.getX(vertex), positions.getX(vertex));
      assert.equal(coordinates.getY(vertex), positions.getY(vertex));
      assert.equal(coordinates.getZ(vertex), positions.getZ(vertex));
    }
  }
  assert.equal(buildCrewGeometry(), buildCrewGeometry(), 'All crew share the same merged geometry');
});

test('interior and complete crew geometry stay within modest-laptop mesh and buffer budgets', (t) => {
  const { group } = interior(t);
  const geometry = meshes(group).map((mesh) => mesh.geometry);
  assert.ok(geometry.reduce((total, item) => total + triangleCount(item), 0) <= 600);
  assert.ok(geometry.reduce((total, item) => total + attributeBytes(item), 0) <= 128 * 1024);
  const crew = buildCrewGeometry();
  assert.ok(triangleCount(crew) <= 800, 'Adding legs does not add draw calls or a high-poly body');
  assert.ok(attributeBytes(crew) <= 96 * 1024);
  assert.equal(crew.getAttribute('color').count, crew.getAttribute('position').count);
  assert.equal(crew.userData['own'], undefined);
  assert.equal(crew.userData['orig'], undefined);
});
