// The town as data: for any map number and number of cars, the layout the generator's plan becomes
// (src/town/from-plan.ts) has the same solid things as the plan itself, as the arena always made them
// (a box per building and stairwell, two posts per canopy, a box and a round end per deck, a post per
// tree, lamp, boulder and bollard), and the same things give way. Every screen and agent builds the
// list with town/colliders.ts, so a prop's number means the same everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateLayout, type Plan } from '../src/layout.ts';
import { fromPlan } from '../src/town/from-plan.ts';
import { colliders, expand, type Obstacle } from '../src/town/colliders.ts';

const pieces = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'data', 'pieces.json'), 'utf8'),
).pieces;
interface Solid {
  kind: 'box' | 'circle';
  x: number;
  z: number;
  r?: number;
  hw?: number;
  hl?: number;
  yaw?: number;
  h: number;
  gives?: string;
}

// what the plan says is solid, as arena.ts made it before towns were data
function fromThePlan(P: Plan): Solid[] {
  const O: Solid[] = [];
  for (const b of [...P.buildings, ...P.stairs])
    O.push({ kind: 'box', x: b.x, z: b.z, hw: b.hw, hl: b.hl, yaw: b.yaw, h: b.h! });
  for (const cp of P.canopies)
    for (const x of [-2, 2])
      O.push({
        kind: 'circle',
        x: cp.x + cp.along[0]! * -x + cp.inward[0]! * 1.6,
        z: cp.z + cp.along[1]! * -x + cp.inward[1]! * 1.6,
        r: 0.15,
        h: 3,
      });
  for (const d of P.decks) {
    const fx = Math.sin(d.yaw),
      fz = Math.cos(d.yaw),
      r = d.hw,
      k = d.round;
    O.push({
      kind: 'box',
      x: d.x - fx * (r / 2) * k,
      z: d.z - fz * (r / 2) * k,
      hw: d.hw,
      hl: (d.hl * 2 - r) / 2,
      yaw: d.yaw,
      h: d.h,
    });
    O.push({ kind: 'circle', x: d.x + fx * (d.hl - r) * k, z: d.z + fz * (d.hl - r) * k, r, h: d.h });
  }
  for (const [x, z] of P.trees) O.push({ kind: 'circle', x, z, r: 0.3, h: 3, gives: 'rowan' });
  for (const [x, z] of P.poplars) O.push({ kind: 'circle', x, z, r: 0.35, h: 6, gives: 'poplar' });
  for (const [x, z] of P.lamps) O.push({ kind: 'circle', x, z, r: 0.15, h: 5, gives: 'lamp' });
  for (const [x, z, r] of P.boulders) O.push({ kind: 'circle', x, z, r: r * 1.05, h: r });
  for (const [x, z] of P.bollards) O.push({ kind: 'circle', x, z, r: 0.12, h: 1, gives: 'bollard' });
  return O;
}

const same = (a: Solid, b: Obstacle): boolean => {
  if (
    a.kind !== b.kind ||
    Math.abs(a.x - b.x) > 0.012 ||
    Math.abs(a.z - b.z) > 0.012 ||
    Math.abs(a.h - b.h) > 0.006
  )
    return false;
  if ((a.gives ?? '') !== (b.breakable ? b.piece : '')) return false;
  if (a.kind === 'circle') return Math.abs(a.r! - b.r) < 0.006;
  // a box turned half way round is the same box; a quarter turn swaps its sides (sizes are kept to the centimetre)
  const d = Math.abs(Math.atan2(Math.sin(2 * (a.yaw! - b.yaw)), Math.cos(2 * (a.yaw! - b.yaw)))) / 2;
  if (d < 0.002) return Math.abs(a.hw! - b.hw) < 0.006 && Math.abs(a.hl! - b.hl) < 0.006;
  return (
    Math.abs(d - Math.PI / 2) < 0.002 && Math.abs(a.hw! - b.hl) < 0.006 && Math.abs(a.hl! - b.hw) < 0.006
  );
};

test('every town the generator lays out has the same solid things as data as in its plan', () => {
  let towns = 0,
    things = 0;
  for (let seed = 1; seed <= 99999; seed += 2999)
    for (let cars = 2; cars <= 8; cars++) {
      const P = generateLayout(seed, cars),
        want = fromThePlan(P),
        got = colliders(expand(fromPlan(P, cars)), pieces);
      assert.equal(got.length, want.length, `map ${seed}, ${cars} cars`);
      const left = [...got];
      for (const w of want) {
        const k = left.findIndex((g) => same(w, g));
        assert.ok(k >= 0, `map ${seed}, ${cars} cars: nothing like ${JSON.stringify(w)}`);
        left.splice(k, 1);
      }
      towns++;
      things += want.length;
    }
  assert.ok(towns > 200 && things > 10000, `${towns} towns, ${things} things`);
});

test('the list comes in the same order every time, the props where the plan has them', () => {
  const P = generateLayout(8411, 4),
    a = colliders(expand(fromPlan(P, 4)), pieces),
    b = colliders(expand(fromPlan(generateLayout(8411, 4), 4)), pieces);
  assert.deepEqual(a, b);
  const props = a
    .filter((o) => o.breakable)
    .map((o) => [o.piece, Math.round(o.x * 100), Math.round(o.z * 100)]);
  const plan = [
    ...P.trees.map((p) => ['rowan', ...p]),
    ...P.poplars.map((p) => ['poplar', ...p]),
    ...P.lamps.map((p) => ['lamp', ...p]),
    ...P.bollards.map((p) => ['bollard', ...p]),
  ].map(([k, x, z]) => [k, Math.round((x as number) * 100), Math.round((z as number) * 100)]);
  assert.deepEqual(props, plan);
});
