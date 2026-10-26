import { test } from 'node:test';
import assert from 'node:assert/strict';
import check from '../src/agent/check.ts';
import { edgeDistance } from '../src/town/geometry.ts';
import type { Layout, Point } from '../src/town/types.ts';

test('reachability keeps signed boundary clearance and observes in-place polygon edits', () => {
  const town: Layout = {
    id: 'boundary-fixture',
    seed: 1,
    size: { x0: -12, z0: -12, w: 24, h: 24 },
    bounds: { poly: [], wall: 1 },
    spawns: [{ x: -3, z: -3, yaw: 0 }],
  };
  const data = { town };
  // Each shape has connected open ground. The concave corner, duplicate vertex and margins
  // around grid centres exercise the clearance predicate independently of its prepared edges.
  const shapes: Point[][] = [
    [
      [-12, -12],
      [12, -12],
      [12, 12],
      [-12, 12],
    ],
    [
      [-10, 0],
      [0, -10],
      [10, 0],
      [0, 10],
    ],
    [
      [-12, -12],
      [12, -12],
      [12, 0],
      [0, 0],
      [0, 12],
      [-12, 12],
    ],
    [
      [-10.28, -11.72],
      [10.28, -11.72],
      [10.28, 11.72],
      [-10.28, 11.72],
      [-10.28, 11.72],
    ],
  ];
  const observed: number[] = [];
  for (const poly of shapes) {
    town.bounds.poly.splice(0, town.bounds.poly.length, ...poly);
    let open = 0;
    for (let z = -11.25; z < 12; z += 1.5)
      for (let x = -11.25; x < 12; x += 1.5) if (edgeDistance(x, z, town.bounds.poly) < -0.97) open++;
    const drivable = check(data).counts['drivable'];
    assert.equal(drivable, Math.round(open * 1.5 * 1.5));
    assert.equal(drivable, check(structuredClone(data)).counts['drivable']);
    assert.ok(drivable !== undefined);
    observed.push(drivable);
  }
  assert.ok(new Set(observed).size > 1, 'editing the same bounds changes the reachable area');
});
