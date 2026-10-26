import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  intersectBox,
  aimDir,
  boxNormal,
  carToWorld,
  rayBox,
  toLocal,
  zoneOf,
} from '../src/gameplay/geometry.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test('car/world transforms are inverse across headings and preserve the supplied output', () => {
  for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 1.234]) {
    const pose = { pos: { x: 13, y: 2, z: -7 }, yaw };
    const out = new Vector3();
    assert.equal(carToWorld(pose, 0.7, 1.2, -2, out), out);
    const local = toLocal(pose, out.x, out.y, out.z);
    near(local.x, 0.7);
    near(local.y, 1.2);
    near(local.z, -2);
  }
});
test('aim direction uses +Z forward, +X at positive yaw and unit length', () => {
  assert.deepEqual(aimDir(0, 0, new Vector3()).toArray(), [0, 0, 1]);
  near(aimDir(Math.PI / 2, 0, new Vector3()).x, 1);
  near(aimDir(2, 0.7, new Vector3()).length(), 1);
  near(aimDir(0, Math.PI / 2, new Vector3()).y, 1);
});
test('damage zones preserve front/rear and left/right conventions at boundaries', () => {
  assert.equal(zoneOf({ x: 0, y: 0, z: 1.551 }), 'front');
  assert.equal(zoneOf({ x: 0, y: 0, z: -1.551 }), 'rear');
  assert.equal(zoneOf({ x: 1, y: 0, z: 1.55 }), 'lf');
  assert.equal(zoneOf({ x: 1, y: 0, z: -0.1 }), 'lr');
  assert.equal(zoneOf({ x: -1, y: 0, z: 0 }), 'rf');
  assert.equal(zoneOf({ x: -1, y: 0, z: -1 }), 'rr');
});
test('slab queries report stable entered faces without shared scratch state', () => {
  const first = intersectBox({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, 0, 0, 0, 0, 1, 2, 2, 10)!;
  assert.deepEqual(first, { t: 3, axis: 2, sign: -1 });
  assert.deepEqual(
    boxNormal(0, first.axis, first.sign, new Vector3())
      .toArray()
      .map((n) => n || 0),
    [0, 0, -1],
  );
  const second = intersectBox({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 0, 0, 0, 0, 1, 2, 2, 10);
  assert.deepEqual(second, { t: 3, axis: 1, sign: 1 });
  assert.deepEqual(first, { t: 3, axis: 2, sign: -1 }, 'a second ray must not overwrite the first result');
});
test('slab queries handle misses, parallel rays, range limits and origins inside the box', () => {
  const query = (o: Vector3, d: Vector3, max = 10) => rayBox(o, d, 0, 0, 0, 0, 1, 2, 2, max);
  assert.equal(query(new Vector3(2, 1, -5), new Vector3(0, 0, 1)), null);
  assert.equal(query(new Vector3(0, 1, -5), new Vector3(0, 0, -1)), null);
  assert.equal(query(new Vector3(0, 1, -5), new Vector3(0, 0, 1), 2.99), null);
  assert.equal(query(new Vector3(0, 1, -5), new Vector3(0, 0, 1), 3), 3);
  assert.equal(query(new Vector3(0, 1, 0), new Vector3(0, 0, 1)), null, 'only entered faces count');
});
test('yawed box face normals rotate with the car', () => {
  const hit = intersectBox({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 0, 0, 0, Math.PI / 2, 1, 2, 2, 10);
  near(hit!.t, 3);
  const normal = boxNormal(Math.PI / 2, hit!.axis, hit!.sign, new Vector3());
  near(normal.x, -1);
  near(normal.y, 0);
  near(normal.z, 0);
});
