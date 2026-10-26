import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import damage from '../data/damage.json' with { type: 'json' };
import { createCarPanelMotion } from '../src/car-panel-motion.ts';
import { BODY_PANELS, createBodyworkState, type BodyPanel } from '../src/gameplay/body-damage.ts';

type PanelMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
const tuning = damage.bodywork;
const near = (actual: THREE.Vector3, expected: THREE.Vector3, message: string) =>
  assert.ok(
    actual.distanceTo(expected) < 0.00001,
    `${message}: ${actual.toArray()} != ${expected.toArray()}`,
  );
function looseBody() {
  const state = createBodyworkState();
  for (const panel of BODY_PANELS) state[panel] = { wear: tuning.panelDamage, looseSince: 0, generation: 1 };
  return state;
}
function boxCar(t: TestContext, shared?: THREE.BufferGeometry) {
  const geometry = shared ?? new THREE.BoxGeometry(0.12, 0.9, 1);
  if (!shared) t.after(() => geometry.dispose());
  const material = new THREE.MeshBasicMaterial();
  t.after(() => material.dispose());
  const body = new THREE.Group();
  const door = new THREE.Mesh(geometry, material);
  door.position.set(0.75, 0.85, 0.4);
  body.add(door);
  const parts: Partial<Record<BodyPanel, PanelMesh>> = { L_Door_Front: door };
  return { body, door, parts, motion: createCarPanelMotion(parts, tuning) };
}

/** The public FBX parser can inspect shipped geometry without DOM, network or image loading. */
class GeometryTextures extends THREE.Loader<THREE.Texture> {
  textures: THREE.Texture[];
  constructor(manager: THREE.LoadingManager, textures: THREE.Texture[]) {
    super(manager);
    this.textures = textures;
  }
  override load(_url: string, _onLoad: (texture: THREE.Texture) => void): THREE.Texture {
    const texture = new THREE.Texture();
    this.textures.push(texture);
    return texture;
  }
}
function actualCar(t: TestContext) {
  const textures: THREE.Texture[] = [];
  const manager = new THREE.LoadingManager();
  manager.addHandler(/.*/, new GeometryTextures(manager, textures));
  const bytes = readFileSync(new URL('../assets/car/Car.fbx', import.meta.url));
  const source = new FBXLoader(manager).parse(Uint8Array.from(bytes).buffer, '');
  source.updateMatrixWorld(true);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const world = new THREE.Box3();
  const geometryByName = new Map<string, THREE.BufferGeometry>();
  source.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material);
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    geometries.add(geometry);
    geometry.computeBoundingBox();
    if (geometry.boundingBox) world.union(geometry.boundingBox);
    geometryByName.set(node.name, geometry);
  });
  t.after(() => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  });
  // The documented model coordinate convention: length4.73m, centered X/Z, tyres on y0.
  const center = world.getCenter(new THREE.Vector3());
  const scale = 4.73 / world.getSize(new THREE.Vector3()).z;
  const body = new THREE.Group();
  const parts: Partial<Record<BodyPanel, PanelMesh>> = {};
  const material = new THREE.MeshBasicMaterial();
  materials.add(material);
  for (const panel of BODY_PANELS) {
    const geometry = geometryByName.get(panel);
    assert.ok(geometry, `The shipped model has a ${panel}`);
    geometry.translate(-center.x, -world.min.y, -center.z).scale(scale, scale, scale);
    geometry.computeBoundingBox();
    assert.ok(geometry.boundingBox);
    const position = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-position.x, -position.y, -position.z);
    geometry.computeBoundingBox();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    parts[panel] = mesh;
    body.add(mesh);
  }
  return { body, parts, motion: createCarPanelMotion(parts, tuning) };
}

// Independently measured hinge positions from the normalized shipped FBX edge strips, in car metres.
const HINGES: Readonly<Record<BodyPanel, readonly [number, number, number]>> = {
  L_Door_Front: [0.78339258, 0.88920262, 0.9234736],
  R_Door_Front: [-0.78339249, 0.88920262, 0.9234736],
  L_Door_Back: [0.71652457, 1.01888925, -0.10800504],
  R_Door_Back: [-0.71652427, 1.01888925, -0.10800504],
  car_hood: [0.00085643, 0.81286713, 0.94813079],
  trunk: [-0.001266, 0.86719948, -1.41235316],
};

test('actual FBX doors and lids move around their cabin-side hinge without new pivot nodes', (t) => {
  const { body, parts, motion } = actualCar(t);
  body.position.set(3, 1, -4);
  body.rotation.set(0.15, 0.7, -0.2);
  body.updateMatrixWorld(true);
  const hinges = BODY_PANELS.map((panel) => {
    const mesh = parts[panel];
    assert.ok(mesh);
    const carPoint = new THREE.Vector3(...HINGES[panel]);
    return { mesh, local: carPoint.clone().sub(mesh.position), world: body.localToWorld(carPoint) };
  });
  const children = [...body.children];
  motion.update(looseBody(), 2, 20, 0.1);
  body.updateMatrixWorld(true);
  for (const hinge of hinges)
    near(hinge.mesh.localToWorld(hinge.local), hinge.world, 'The hinge stays attached');
  assert.deepEqual(body.children, children, 'Motion must not introduce groups, meshes or draw calls');
});

test('loose doors swing outwards and both lids lift; motion remains bounded over time', (t) => {
  const { parts, motion } = actualCar(t);
  const state = looseBody();
  for (let frame = 0; frame < 900; frame++) {
    motion.update(state, frame / 60, frame % 2 ? 1e6 : -1e6, 1 / 60);
    for (const panel of BODY_PANELS) {
      const mesh = parts[panel];
      assert.ok(mesh);
      assert.ok([...mesh.position.toArray(), ...mesh.quaternion.toArray()].every(Number.isFinite));
      assert.ok(mesh.quaternion.angleTo(new THREE.Quaternion()) <= 1.05, 'Damage never flips a whole panel');
      if (frame < 10) continue;
      const bounds = mesh.geometry.boundingBox;
      assert.ok(bounds);
      const free = new THREE.Vector3(0, 0, panel === 'car_hood' ? bounds.max.z : bounds.min.z);
      const rest = free.clone().add(motion.restPosition(mesh));
      free.applyQuaternion(mesh.quaternion).add(mesh.position);
      if (panel === 'car_hood' || panel === 'trunk') assert.ok(free.y > rest.y, 'The free lid edge lifts');
      else
        assert.ok(
          (free.x - rest.x) * (panel.startsWith('L_') ? 1 : -1) > 0,
          'Doors open away from the cabin',
        );
    }
  }
});

test('a hanging door remains raycastable at its displaced surface with unchanged geometry', (t) => {
  const { body, door, motion } = boxCar(t);
  const positions = door.geometry.getAttribute('position');
  const vertices = Float32Array.from(positions.array);
  const index = door.geometry.getIndex();
  motion.update(looseBody(), 2, 20, 0.1);
  body.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(
    new THREE.Vector3(2, 0.85, 0.1),
    new THREE.Vector3(-1, 0, 0),
  ).intersectObject(body)[0];
  assert.ok(hit);
  assert.ok(hit.point.x > 0.9, 'A side view sees the hanging door outside the closed body');
  assert.equal(door.geometry.getAttribute('position'), positions);
  assert.equal(door.geometry.getIndex(), index);
  assert.deepEqual(positions.array, vertices, 'Animation must not rewrite shared or dented vertices');
});

test('zero or invalid dt pauses transforms, and a long frame uses the bounded interpolation step', (t) => {
  const first = boxCar(t);
  const second = boxCar(t, first.door.geometry);
  const state = looseBody();
  first.motion.update(state, 2, 20, 0.1);
  second.motion.update(state, 2, 20, 100);
  near(first.door.position, second.door.position, 'Long frames are capped');
  assert.ok(first.door.quaternion.angleTo(second.door.quaternion) < 1e-7);
  const position = first.door.position.clone();
  const quaternion = first.door.quaternion.clone();
  for (const dt of [0, -1, NaN, Infinity]) first.motion.update(state, 5, 20, dt);
  for (const time of [-1, NaN, Infinity]) first.motion.update(state, time, 20, 1 / 60);
  near(first.door.position, position, 'Paused and invalid clocks preserve the pose');
  assert.ok(first.door.quaternion.angleTo(quaternion) < 1e-7);
  first.motion.update(state, 5, NaN, 1 / 60);
  assert.ok([...first.door.position.toArray(), ...first.door.quaternion.toArray()].every(Number.isFinite));
});

test('shared geometry does not share motion, and canonical dent coordinates stay constant', (t) => {
  const first = boxCar(t);
  const other = boxCar(t, first.door.geometry);
  const rest = first.motion.restPosition(first.door);
  const restCoordinates = rest.clone();
  const otherPosition = other.door.position.clone();
  first.motion.update(looseBody(), 2, 20, 0.1);
  assert.equal(first.motion.restPosition(first.door), rest, 'The canonical position is cached');
  near(rest, restCoordinates, 'Damage sampling must not depend on the interpolated pose');
  assert.ok(first.door.position.distanceTo(rest) > 0.05);
  near(other.door.position, otherPosition, 'Another car sharing the geometry stays still');
  assert.equal(other.door.quaternion.angleTo(new THREE.Quaternion()), 0);
  const fixedBodyMesh = new THREE.Object3D();
  assert.equal(
    first.motion.restPosition(fixedBodyMesh),
    fixedBodyMesh.position,
    'Nonpanels retain their ordinary coordinate contract',
  );
});

test('detached or replaced panels belong to debris, while body-mounted turrets stay still', (t) => {
  const { body, door, parts, motion } = boxCar(t);
  const turret = new THREE.Group();
  turret.position.set(0, 0.9, 1.45);
  body.add(turret);
  const mount = turret.position.clone();
  const state = looseBody();
  motion.update(state, 2, 20, 0.1);
  near(turret.position, mount, 'Body-mounted markers must not flap with supporting panels');
  const debris = new THREE.Group();
  debris.add(door);
  door.position.set(3, 4, 5);
  door.rotation.set(0.2, 0.3, 0.4);
  const quaternion = door.quaternion.clone();
  motion.update(state, 3, 20, 0.1);
  near(door.position, new THREE.Vector3(3, 4, 5), 'Debris simulation owns the detached pose');
  assert.ok(door.quaternion.angleTo(quaternion) < 1e-7);
  body.add(door);
  delete parts.L_Door_Front;
  motion.update(state, 4, 20, 0.1);
  near(door.position, new THREE.Vector3(3, 4, 5), 'A stale cached entry cannot move a removed panel');
});

test('intact and repaired panels settle at their original transforms without steady frame updates', (t) => {
  const { door, motion } = boxCar(t);
  const state = createBodyworkState();
  const rest = door.position.clone();
  motion.update(state, 2, 20, 1 / 60);
  near(door.position, rest, 'Healthy panels remain closed');
  state.L_Door_Front = { wear: tuning.panelDamage, looseSince: 0, generation: 1 };
  motion.update(state, 2, 20, 0.1);
  state.L_Door_Front = { wear: 0, looseSince: null, generation: 1 };
  for (let frame = 0; frame < 180; frame++) motion.update(state, 3 + frame / 60, 20, 1 / 60);
  near(door.position, rest, 'Reset damage closes the panel');
  assert.equal(door.quaternion.angleTo(new THREE.Quaternion()), 0);
  const writes = t.mock.method(door.quaternion, 'copy');
  for (let frame = 0; frame < 60; frame++) motion.update(state, 8 + frame / 60, 20, 1 / 60);
  assert.equal(writes.mock.callCount(), 0, 'Settled panels do not repeatedly rewrite their pose');
});
