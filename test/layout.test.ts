import type { Pt } from '../src/layout.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA_PER_CAR, RECIPE, generateLayout, mulberry32, pointInPoly } from '../src/layout.ts';

const SEEDS = Array.from({ length: 120 }, (_, i) => i * 7919 + 1);

test('the random numbers are seeded and stay in [0, 1)', () => {
  const a = mulberry32(42),
    b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('the same map number always gives the same map', () => {
  for (const seed of [1, 46, 99999]) assert.deepEqual(generateLayout(seed), generateLayout(seed));
});

test('the town is sized for the cars', () => {
  const size = (cars: number) => {
    const P = generateLayout(7, cars);
    return 4 * P.hx * P.hz;
  };
  for (const cars of [8, 12, 16])
    assert.ok(Math.abs(size(cars) - cars * AREA_PER_CAR) < 1, `${cars} cars: ${cars} cars' worth`);
  assert.equal(size(2), size(4), 'below six cars it stops shrinking');
  assert.ok(size(4) < size(8), 'but four cars get a smaller town than eight');
});

test('every map is playable, for 4 to 16 cars', () => {
  for (const cars of [4, 8, 12, 16])
    for (const seed of SEEDS) {
      const P = generateLayout(seed, cars),
        at = `map ${seed} for ${cars} cars`;
      const inside = (x: number, z: number) => pointInPoly(x, z, P.bounds);
      // the office with its deck and canopy is always there, and the pavilion
      assert.equal(P.decks.length, 1, `${at}: deck`);
      assert.equal(P.canopies.length, 1, `${at}: canopy`);
      assert.ok(
        P.buildings.some((b) => b.look === 'pavilion'),
        `${at}: no pavilion`,
      );
      assert.ok(P.exits.length >= 1, `${at}: no way out of town`);
      // everything that stands in the town stands inside the edge
      for (const b of P.buildings) if (!b.outer) assert.ok(inside(b.x, b.z), `${at}: a building is outside`);
      for (const [x, z] of [...P.trees, ...P.poplars, ...P.lamps])
        assert.ok(inside(x, z), `${at}: a tree or lamp is outside`);
      for (const h of P.hedges)
        assert.ok(Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]) > 0.05, `${at}: a hedge of no length`);
      // every number is a number
      const flat = JSON.stringify(P);
      assert.ok(!/null|NaN|Infinity/.test(flat), `${at}: not a number somewhere`);
      // no street ends in a dead end: where a street stops, another goes on (or it meets the ring, or leaves town)
      const ring = P.streets.filter((s) => s.ring),
        inner = P.streets.filter((s) => !s.ring);
      const same = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
      const onRing = (p: Pt) => ring.some((s) => segDist(p, s.a, s.b) < 0.01);
      const outOfTown = (p: Pt) =>
        !pointInPoly(p[0] * 0.999, p[1] * 0.999, P.bounds) || Math.abs(Math.abs(p[0]) - P.hx) < 0.01;
      for (const s of inner)
        for (const p of [s.a, s.b]) {
          const n =
            inner.filter((o) => same(o.a, p) || same(o.b, p)).length +
            (onRing(p) ? 2 : 0) +
            (outOfTown(p) ? 2 : 0);
          assert.ok(n >= 2, `${at}: dead end at ${p}`);
        }
    }
});

function segDist(p: Pt, a: Pt, b: Pt) {
  const ex = b[0] - a[0],
    ez = b[1] - a[1],
    l2 = ex * ex + ez * ez;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t);
}

test('incomplete generator ranges fail before publishing a non-finite layout', () => {
  const missingFloatBound = structuredClone(RECIPE);
  missingFloatBound.blocks.w.length = 1;
  assert.throws(() => generateLayout(7, 4, missingFloatBound), /Missing generator range bound/);
  const missingIntegerBound = structuredClone(RECIPE);
  missingIntegerBound.corners.cuts.length = 1;
  assert.throws(() => generateLayout(7, 4, missingIntegerBound), /Missing integer generator range bound/);
});
