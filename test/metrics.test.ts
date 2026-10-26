import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { RoundMetrics, roundMetricLabels, createRoundMetricReporter } from '../src/gameplay/metrics.ts';
test('round records use this round points rather than lifetime totals and emit once', () => {
  const metrics = new RoundMetrics();
  const reports: [string, number][] = [];
  const report = (name: string, value: number): void => {
    reports.push([name, value]);
  };
  const state = {
    round: 2,
    state: 'countdown',
    time: 0,
    points: [1000, 50],
    cars: [{ alive: true }, { alive: true }],
  };
  metrics.begin(state);
  metrics.update(state, report);
  assert.deepEqual(reports, []);
  Object.assign(state, {
    state: 'over',
    time: 32,
    points: [1020, 250],
    cars: [{ alive: false }, { alive: true }],
  });
  metrics.update(state, report);
  metrics.update(state, report);
  assert.deepEqual(reports, [
    ['rounds_total', 1],
    ['round_points_earned', 220],
    ['wrecks_total', 1],
    ['round_seconds', 32],
    ['round_points', 200],
    ['round_wrecks', 1],
  ]);
  metrics.update({ ...state, round: 3 }, report);
  assert.equal(reports.length, 6);
});

test('live values are sampled once per second and never become score records', () => {
  const metrics = new RoundMetrics();
  const reports: [string, number][] = [];
  const report = (name: string, value: number): void => {
    reports.push([name, value]);
  };
  const state = {
    round: 1,
    state: 'countdown',
    time: 0,
    points: [100, 20],
    cars: [{ alive: true }, { alive: true }],
  };
  metrics.begin(state);
  Object.assign(state, { state: 'playing', points: [120, 60] });
  metrics.update(state, report);
  state.time = 0.5;
  metrics.update(state, report);
  assert.deepEqual(reports, [
    ['points', 40],
    ['cars_remaining', 2],
    ['round_elapsed_seconds', 0],
  ]);
  state.time = 1;
  state.cars[0] = { alive: false };
  metrics.update(state, report);
  assert.deepEqual(reports.slice(-3), [
    ['points', 40],
    ['cars_remaining', 1],
    ['round_elapsed_seconds', 1],
  ]);
  assert(!reports.some(([name]) => name === 'round_points'));
});

test('fixed round dimensions reject undeclared values and never contain identifying labels', () => {
  assert.deepEqual(roundMetricLabels(2, 0), { format: 'generated', cars: '2', bots: '0' });
  assert.deepEqual(roundMetricLabels(8, 2), { format: 'generated', cars: '8', bots: '2' });
  for (const cars of [null, {}, '2', 1, 9, 2.5, NaN, Infinity])
    assert.equal(roundMetricLabels(cars, 0), null);
  for (const bots of [null, {}, '0', -1, 3, 1.5, NaN, Infinity])
    assert.equal(roundMetricLabels(2, bots), null);
});

test('every emitted round metric and dimension matches the actual shipped manifest', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../zirbel.json', import.meta.url), 'utf8'));
  assert.ok(
    manifest && typeof manifest === 'object' && 'metrics' in manifest && Array.isArray(manifest.metrics),
  );
  const declarations = manifest.metrics;
  for (let cars = 2; cars <= 8; cars++) {
    for (let bots = 0; bots <= 2; bots++) {
      const names = new Set<string>();
      const report = createRoundMetricReporter(
        (name, value, labels) => {
          names.add(name);
          assert.ok(Number.isFinite(value));
          const declaration: unknown = declarations.find(
            (item: unknown) => item && typeof item === 'object' && 'name' in item && item.name === name,
          );
          assert.ok(declaration && typeof declaration === 'object', `undeclared metric ${name}`);
          const allowed = 'labels' in declaration ? declaration.labels : {};
          assert.ok(allowed && typeof allowed === 'object' && !Array.isArray(allowed));
          assert.deepEqual(Object.keys(labels).sort(), Object.keys(allowed).sort(), `${name} label keys`);
          for (const [key, label] of Object.entries(labels)) {
            assert.ok(key in allowed, `${name} unknown label ${key}`);
            const values: unknown = Reflect.get(allowed, key);
            assert.ok(Array.isArray(values) && values.includes(label), `${name} invalid ${key}=${label}`);
          }
        },
        { cars, bots, format: 'generated' },
      );
      const state = {
        round: 1,
        state: 'playing',
        time: 1,
        points: [0, 0],
        cars: Array.from({ length: cars }, () => ({ alive: true })),
      };
      const metrics = new RoundMetrics();
      metrics.begin(state);
      metrics.update(state, report);
      state.state = 'over';
      state.points = [20, 30];
      metrics.update(state, report);
      assert.equal(names.size, 9);
      assert.ok(names.has('round_points_earned'));
      assert.ok(!names.has('points_total'));
    }
  }
});

test('unsupported map or dimensions do not publish falsely labeled completed results', () => {
  for (const config of [
    { cars: 2, bots: 0, format: 'town' },
    { cars: 9, bots: 0, format: 'generated' },
    { cars: 2, bots: 3, format: 'generated' },
  ]) {
    const emitted: { name: string; labels: Readonly<Record<string, string>> }[] = [];
    const reporter = createRoundMetricReporter((name, _value, labels) => {
      emitted.push({ name, labels });
    }, config);
    const metrics = new RoundMetrics();
    const state = {
      round: 1,
      state: 'playing',
      time: 1,
      points: [0, 0],
      cars: [{ alive: true }, { alive: true }],
    };
    metrics.begin(state);
    metrics.update(state, reporter);
    state.state = 'over';
    metrics.update(state, reporter);
    assert.deepEqual(emitted, [
      { name: 'points', labels: {} },
      { name: 'cars_remaining', labels: {} },
      { name: 'round_elapsed_seconds', labels: {} },
    ]);
  }
});
