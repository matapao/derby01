import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceMiniGame,
  startMiniGame,
  isMiniGameKind,
  type MiniGameKind,
  type MechanicTask,
} from '../src/gameplay/minigames.ts';
import { precisionAction, precisionResult } from '../src/gameplay/minigame-precision.ts';
import { input, minigameFixture, task } from './minigame-fixture.ts';

const kinds: MiniGameKind[] = [
  'glue',
  'nuts',
  'hammer',
  'dial',
  'spray',
  'pour',
  'dents',
  'radar',
  'glass',
  'unjam',
];
test('every minigame initializes finite progress and independent state; invalid time is inert', () => {
  const { games, car, active, effects } = minigameFixture();
  for (const kind of kinds) {
    const first = active(kind),
      second = active(kind),
      before = structuredClone(first);
    assert.equal(first.type, kind);
    assert.equal(first.prog, 0);
    assert.notEqual(first, second);
    for (const dt of [0, -1, NaN, Infinity])
      assert.equal(advanceMiniGame(games, first, input({ a: true, aP: true }), dt, car), false);
    assert.deepEqual(first, before, kind);
  }
  const first = active('nuts'),
    second = active('nuts');
  first.seq[0] = 'left';
  assert.equal(second.seq[0], 'up');
  assert.deepEqual(effects, []);
});
test('nuts require the correct sequence before fitting taps, and a wrong direction locks input', () => {
  const { games, car, active, rules } = minigameFixture(),
    game = active('nuts');
  advanceMiniGame(games, game, input({ tap: 'left' }), 0.01, car);
  assert.equal(game.i, 0);
  assert.ok(game.lock > 0);
  advanceMiniGame(games, game, input({ tap: 'up' }), 0.01, car);
  assert.equal(game.i, 0, 'wrong-input lock cannot be skipped');
  advanceMiniGame(games, game, input(), rules.nuts.pause + 0.01, car);
  for (const direction of game.seq)
    advanceMiniGame(games, game, input({ tap: direction, aP: true }), 0.01, car);
  assert.equal(game.mash, 0, 'sequence taps cannot double as fitting taps');
  for (let n = 0; n < rules.nuts.taps - 1; n++)
    assert.equal(advanceMiniGame(games, game, input({ aP: true }), 0.01, car), false);
  assert.equal(advanceMiniGame(games, game, input({ aP: true }), 0.01, car), true);
  assert.equal(game.prog, 1);
});

test('panel nuts use a quick hinge sequence, record precision and wait for the minimum repair time', () => {
  const { games, car, rules, effects } = minigameFixture();
  const panel: MechanicTask = {
    id: 'panel:car_hood:1',
    kind: 'panel',
    name: 'car_hood',
    generation: 1,
    label: 'Hood',
    urg: 50,
  };
  const game = startMiniGame(games, 'nuts', panel, car);
  assert.equal(game.panel, true);
  assert.equal(game.seq.length, rules.nuts.panelNuts);
  assert.equal(game.taps, rules.nuts.panelTaps);
  assert.equal(game.minTime, rules.nuts.panelTime);
  const wrong = input({ tap: 'left' });
  const miss = precisionAction(game, wrong, 0.01)!;
  advanceMiniGame(games, game, wrong, 0.01, car);
  assert.equal(precisionResult(miss, game), 0);
  assert.equal(game.lock, rules.nuts.panelPause);
  advanceMiniGame(games, game, input(), rules.nuts.panelPause + 0.01, car);
  for (const direction of game.seq) {
    const frame = input({ tap: direction, aP: true }),
      action = precisionAction(game, frame, 0.01)!;
    assert.equal(advanceMiniGame(games, game, frame, 0.01, car), false);
    assert.equal(precisionResult(action, game), 1);
  }
  assert.equal(game.mash, 0);
  for (let tap = 0; tap < game.taps; tap++)
    assert.equal(advanceMiniGame(games, game, input({ aP: true }), 0.01, car), false);
  assert.ok(game.prog < 1);
  assert.equal(precisionAction(game, input({ aP: true }), 0.01), null);
  while (game.elapsed + 0.1 < game.minTime)
    assert.equal(advanceMiniGame(games, game, input(), 0.1, car), false);
  assert.equal(advanceMiniGame(games, game, input(), game.minTime - game.elapsed + 0.001, car), true);
  assert.equal(game.prog, 1);
  assert.equal(effects.filter((effect) => effect === 'clang').length, rules.nuts.panelTaps);
  const tyre = startMiniGame(games, 'nuts', task('tire'), car);
  assert.equal(tyre.panel, false);
  assert.equal(tyre.minTime, 0);
  assert.equal(tyre.seq.length, rules.nuts.nuts);
  assert.equal(tyre.taps, rules.nuts.taps);
});
test('unjamming follows directions in order and reports completion only after the last', () => {
  const { games, car, active } = minigameFixture(),
    game = active('unjam');
  game.seq.forEach((direction, index) =>
    assert.equal(
      advanceMiniGame(games, game, input({ tap: direction }), 0.01, car),
      index === game.seq.length - 1,
    ),
  );
  assert.equal(game.prog, 1);
});
test('glue overheats with continuous heat, penalizes progress and never makes it negative', () => {
  const { games, car, active, effects } = minigameFixture(),
    game = active('glue');
  game.heat = 0.99;
  game.prog = 0.01;
  assert.equal(advanceMiniGame(games, game, input({ a: true }), 0.25, car), false);
  assert.equal(game.heat, 0.3);
  assert.ok(game.prog >= 0);
  assert.ok(game.burn > 0);
  assert.ok(effects.includes('fail'));
});
test('hammer rewards timed taps, while misses do not add hits', () => {
  const { games, car, active } = minigameFixture(),
    game = active('hammer');
  game.zone = 0.5;
  game.t = 0.5;
  advanceMiniGame(games, game, input({ aP: true }), 0.000001, car);
  assert.equal(game.hits, 1);
  game.zone = 0.9;
  game.t = 0;
  advanceMiniGame(games, game, input({ aP: true }), 0.000001, car);
  assert.equal(game.hits, 1);
  assert.ok(game.miss > 0);
});
test('dial progress requires dwelling in the band and drains outside it', () => {
  const { games, car, active } = minigameFixture(),
    game = active('dial');
  game.target = game.a = 0;
  game.drift = game.v = 0;
  game.driftT = 100;
  advanceMiniGame(games, game, input(), 0.1, car);
  const progress = game.prog;
  assert.ok(progress > 0);
  game.a = 1;
  advanceMiniGame(games, game, input(), 0.1, car);
  assert.ok(game.prog < progress);
  assert.equal(game.in, false);
});
test('spray empties under continuous use, recovers when released, and targets flame bases', () => {
  const { games, car, active, rules } = minigameFixture(),
    game = active('spray');
  game.pressure = 0.001;
  advanceMiniGame(games, game, input({ a: true }), 0.1, car);
  assert.equal(game.empty, true);
  assert.equal(game.pressure, 0);
  for (let n = 0; n < 100; n++) advanceMiniGame(games, game, input(), 0.1, car);
  assert.equal(game.empty, false);
  assert.equal(game.pressure, 1);
  game.flames = [{ x: 0.5, y: 0.5, hp: rules.spray.base * 0.01 }];
  game.cx = game.cy = 0.5;
  assert.equal(advanceMiniGame(games, game, input({ a: true }), 0.1, car), true);
  assert.equal(game.prog, 1);
});
test('pouring transfers fuel at the configured rate and never consumes more than the can holds', () => {
  const { games, car, active, rules } = minigameFixture(),
    game = active('pour');
  advanceMiniGame(games, game, input({ a: true }), 0.25, car);
  assert.equal(car.sys.fuel, rules.pour.rate * 0.25);
  game.can = 1;
  car.sys.fuel = 0;
  assert.equal(advanceMiniGame(games, game, input({ a: true }), 0.25, car), true);
  assert.equal(car.sys.fuel, 1);
  assert.equal(game.can, 0);
});
test('pouring into a full tank spills, while releasing a sufficiently full tank ends the job', () => {
  const { games, car, active, effects } = minigameFixture(),
    game = active('pour');
  car.sys.fuel = 99;
  advanceMiniGame(games, game, input({ a: true }), 0.25, car);
  assert.equal(car.sys.fuel, 90);
  assert.ok(game.spill > 0);
  assert.ok(effects.includes('fail'));
  car.sys.fuel = 98;
  assert.equal(advanceMiniGame(games, game, input(), 0.01, car), true);
});
test('dents require alternating directions; repeating one direction cannot complete a repair', () => {
  const { games, car, active } = minigameFixture(),
    game = active('dents');
  advanceMiniGame(games, game, input({ tap: 'left' }), 0.01, car);
  advanceMiniGame(games, game, input({ tap: 'left' }), 0.01, car);
  assert.equal(game.n, 1);
  while (game.n < game.need) advanceMiniGame(games, game, input({ tap: game.next }), 0.01, car);
  assert.equal(game.prog, 1);
});
test('radar rebuilds require more hits than repairs, and off-target taps do not count', () => {
  const { games, car, active, rules } = minigameFixture(),
    game = active('radar');
  const destroyed = { ...task('radar'), kind: 'radar' as const, destroyed: true };
  assert.equal(startMiniGame(games, 'radar', destroyed, car).need, rules.radar.rebuild);
  assert.equal(game.need, rules.radar.repair);
  game.a = game.blip = 1;
  advanceMiniGame(games, game, input({ aP: true }), 0.000001, car);
  assert.equal(game.hits, 1);
  game.blip = 4;
  game.a = 0;
  advanceMiniGame(games, game, input({ aP: true }), 0.000001, car);
  assert.equal(game.hits, 1);
  assert.ok(game.miss > 0);
});
test('glass requires demolition before alignment; taps outside the alignment window miss', () => {
  const { games, car, active, rules } = minigameFixture(),
    game = active('glass');
  for (let n = 0; n < rules.glass.knocks; n++)
    assert.equal(advanceMiniGame(games, game, input({ aP: true }), 0.01, car), false);
  assert.equal(game.phase, 1);
  assert.equal(game.hits, 0);
  game.x = 0.8;
  advanceMiniGame(games, game, input({ aP: true }), 0.000001, car);
  assert.equal(game.hits, 0);
  for (let n = 0; n < rules.glass.hits; n++) {
    game.x = 0;
    assert.equal(
      advanceMiniGame(games, game, input({ aP: true }), 0.000001, car),
      n === rules.glass.hits - 1,
    );
  }
  assert.equal(game.prog, 1);
});

test('minigame identifiers reject inherited properties and unknown data', () => {
  for (const value of ['constructor', '__proto__', 'typo', null, 1, {}])
    assert.equal(isMiniGameKind(value), false);
  for (const kind of kinds) assert.equal(isMiniGameKind(kind), true);
});
