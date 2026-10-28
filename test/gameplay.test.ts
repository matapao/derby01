import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScoring,
  newBurn,
  type ScoringCar,
  type ScoreEvent,
  type ScoreState,
} from '../src/gameplay/scoring.ts';
import { createSystems } from '../src/gameplay/systems.ts';
import { applyChassisDamage } from '../src/gameplay/damage.ts';
import { completeRound } from '../src/gameplay/round.ts';
import { createInputState, finishInputFrame, releaseInput } from '../src/gameplay/input.ts';
import points from '../data/points.json' with { type: 'json' };

function car(team = 0): ScoringCar {
  return {
    team,
    alive: true,
    grounded: true,
    yaw: 0,
    yawRate: 0,
    vel: { x: 8, z: 8 },
    ctrl: { throttle: 1, steer: 1, handbrake: false, boost: false },
    mods: { power: 1 },
    lastHitBy: null,
    lastHitTime: -99,
  };
}
function fixture() {
  const events: ScoreEvent[] = [];
  const state: ScoreState = { state: 'playing', time: 0, points: [0, 0], stats: {} };
  const rules = structuredClone(points);
  const scoring = createScoring(state, rules, (event) => events.push(event));
  const step = (vehicle: ScoringCar, seconds: number) => {
    for (let time = 0; time < seconds; time += 0.25) {
      state.time += 0.25;
      scoring.updateBurn(vehicle, 0.25);
    }
  };
  return { events, state, rules, scoring, step };
}
test('damage scoring ignores self/team damage, invalid amounts and non-playing phases', () => {
  const { state, scoring, events } = fixture(),
    victim = car(0),
    enemy = car(1);
  for (const source of [victim, car(0), null]) scoring.scoreDamage(victim, 10, source);
  for (const amount of [NaN, Infinity, -10, 0]) scoring.scoreDamage(victim, amount, enemy);
  state.state = 'paused';
  scoring.scoreDamage(victim, 10, enemy);
  assert.deepEqual(state.points, [0, 0]);
  state.state = 'playing';
  scoring.scoreDamage(victim, 12.5, enemy);
  assert.deepEqual(state.points, [0, 12.5]);
  assert.equal(state.stats.points?.['damage'], 12.5);
  assert.deepEqual(events, [], 'ordinary damage has no popup event');
});
test('awards reject invalid amounts and emit the credited value once', () => {
  const { state, scoring, events } = fixture(),
    vehicle = car();
  for (const amount of [NaN, Infinity, -1, 0]) scoring.award(vehicle, amount, 'BAD');
  scoring.award(undefined, 50, 'BAD');
  assert.deepEqual(state.points, [0, 0]);
  scoring.award(vehicle, 250, 'WRECK', 'wreck');
  assert.equal(state.stats.points?.['wreck'], 250);
  assert.deepEqual(events, [{ kind: 'award', car: vehicle, points: 250, label: 'WRECK' }]);
});
test('radar credit uses a recent enemy hit and expires at the credit window', () => {
  const { state, scoring, events } = fixture(),
    victim = car(),
    source = car(1);
  victim.lastHitBy = source;
  victim.lastHitTime = 0;
  state.time = 2.5;
  scoring.scoreRadar(victim, null);
  assert.deepEqual(state.points, [0, 0]);
  state.time = 2.49;
  scoring.scoreRadar(victim, null);
  assert.equal(state.points[1], 150);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['award', 'radar', 'radarMark'],
  );
  scoring.scoreRadar(victim, victim);
  scoring.scoreRadar(victim, car());
  assert.equal(state.points[1], 150);
});
test('an unintentional shove, airborne car or powerless engine cannot start a burn', () => {
  for (const setup of ['shove', 'airborne', 'powerless']) {
    const { state, step } = fixture(),
      vehicle = car();
    if (setup === 'shove') {
      vehicle.ctrl.steer = 0;
      vehicle.ctrl.handbrake = false;
    }
    if (setup === 'airborne') vehicle.grounded = false;
    if (setup === 'powerless') vehicle.mods.power = 0;
    step(vehicle, 2);
    assert.equal(vehicle.burn?.on, false, setup);
    assert.deepEqual(state.points, [0, 0]);
  }
});
test('a deliberate two-second drift banks 42 points after the grace period, only once', () => {
  const { scoring, state, events, step } = fixture(),
    vehicle = car();
  step(vehicle, 2);
  assert.equal(vehicle.burn?.on, true);
  assert.equal(state.points[0], 0, 'points remain at risk while drifting');
  vehicle.vel = { x: 0, z: 0 };
  step(vehicle, 0.5);
  assert.equal(state.points[0], 0, 'grace window includes its upper boundary');
  step(vehicle, 0.25);
  scoring.endBurn(vehicle, true);
  assert.equal(state.points[0], 42);
  assert.equal(state.stats.points?.['burn'], 42);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['award', 'burnEnd'],
  );
});
test('hard crashes lose an eligible burn; small impacts preserve it', () => {
  const { scoring, state, events, step } = fixture(),
    vehicle = car();
  step(vehicle, 2);
  scoring.burnCrash(vehicle, 5);
  assert.equal(vehicle.burn?.on, true);
  scoring.burnCrash(vehicle, 5.01);
  scoring.endBurn(vehicle, true);
  assert.equal(state.points[0], 0);
  assert.deepEqual(events, [{ kind: 'burnEnd', car: vehicle, keep: false }]);
});
test('short burns do not score and maximum-length burns bank without duplicate awards', () => {
  const { rules, scoring, state, events, step } = fixture(),
    vehicle = car();
  step(vehicle, 1);
  scoring.endBurn(vehicle, true);
  assert.equal(events.length, 0);
  rules.burn.max = 2;
  step(vehicle, 2);
  scoring.endBurn(vehicle, true);
  assert.equal(state.points[0], 42);
  assert.equal(events.filter((event) => event.kind === 'award').length, 1);
  assert.equal(vehicle.burn?.t, 0);
});
test('pause/death clear burn progress and invalid time cannot poison it', () => {
  for (const stop of ['pause', 'death']) {
    const { state, scoring, step } = fixture(),
      vehicle = car();
    step(vehicle, 2);
    if (stop === 'pause') state.state = 'paused';
    else vehicle.alive = false;
    scoring.updateBurn(vehicle, 0.25);
    assert.equal(vehicle.burn?.t, 0);
    assert.equal(vehicle.burn?.on, false);
    for (const dt of [NaN, Infinity, -1, 0]) scoring.updateBurn(vehicle, dt);
    assert.equal(vehicle.burn?.t, 0);
    assert.deepEqual(state.points, [0, 0]);
  }
  assert.deepEqual(newBurn(), { t: 0, off: 0, on: false, kick: -99 });
});
test('round completion counts teams, banks burns before the win and cannot resolve twice', () => {
  const { state, scoring, events, step } = fixture(),
    winner = car(),
    teammate = car(),
    loser = car(1);
  step(winner, 2);
  loser.alive = false;
  const round = Object.assign(state, {
    cars: [winner, teammate, loser],
    overTimer: 0,
    winnerTeam: -1,
    teamScores: [0, 0],
  });
  assert.equal(completeRound(round, 8, 200, scoring), true);
  assert.equal(round.state, 'over');
  assert.equal(round.winnerTeam, 0);
  assert.equal(round.overTimer, 8);
  assert.deepEqual(round.teamScores, [1, 0]);
  assert.deepEqual(state.points, [242, 0]);
  assert.deepEqual(
    events.filter((event) => event.kind === 'award').map((event) => event.label),
    ['BURN 2.0s', 'ROUND WIN'],
  );
  assert.equal(completeRound(round, 8, 200, scoring), false);
  assert.deepEqual(state.points, [242, 0]);
});
test('a contested round stays open; a draw awards nobody', () => {
  const { state, scoring } = fixture(),
    first = car(),
    second = car(1);
  const round = Object.assign(state, {
    cars: [first, second],
    overTimer: 0,
    winnerTeam: -1,
    teamScores: [0, 0],
  });
  assert.equal(completeRound(round, 8, 200, scoring), false);
  first.alive = second.alive = false;
  assert.equal(completeRound(round, 8, 200, scoring), true);
  assert.equal(round.winnerTeam, -1);
  assert.deepEqual(round.teamScores, [0, 0]);
  assert.deepEqual(round.points, [0, 0]);
});
test('system creation gives every car separate mutable arrays and spares', () => {
  const stock = { fuel: 2, tyres: 3, bumpers: 4, glass: 1 };
  const first = createSystems(80, stock),
    second = createSystems(80, stock);
  first.sys.tires[0] = 0;
  first.sys.axles[0] = 0;
  first.sys.tireHp[1] = 0;
  first.sys.rim[2] = 0;
  first.sys.wheelOff[3] = true;
  first.stock.fuel = 0;
  first.mods.power = 0;
  assert.deepEqual(second, createSystems(80, stock));
  assert.equal(stock.fuel, 2);
  assert.equal(second.sys.maxHp, 80);
});
test('chassis damage respects toughness, remaining health, phase and permanent fatigue', () => {
  const vehicle = { alive: true, hp: 50, sys: { maxHp: 80 } };
  assert.equal(applyChassisDamage(vehicle, 20, 'playing', 2, 0.1), 10);
  assert.equal(vehicle.hp, 40);
  assert.equal(vehicle.sys.maxHp, 79);
  assert.equal(
    applyChassisDamage(vehicle, 100, 'playing', 1, 0.1),
    40,
    'overkill never scores more than remaining health',
  );
  assert.equal(vehicle.hp, 0);
  assert.equal(vehicle.sys.maxHp, 75);
  for (const amount of [NaN, Infinity, -1, 0, 0.01])
    assert.equal(applyChassisDamage(vehicle, amount, 'playing', 1, 0.1), 0);
  assert.equal(applyChassisDamage(vehicle, 10, 'paused', 1, 0.1), 0);
  vehicle.alive = false;
  assert.equal(applyChassisDamage(vehicle, 10, 'playing', 1, 0.1), 0);
});
test('frame cleanup preserves held input while focus loss clears held and edge input', () => {
  const input = createInputState();
  input.keys.add('KeyW');
  input.pressed.add('KeyC');
  Object.assign(input.mouse, { buttons: 1, pressed: 1, dx: 5, dy: -2, wheel: 1 });
  input.pads.push({ id: 'pad', buttons: [true], values: [1], axes: [1, 0] });
  input.padPrev.push([true]);
  finishInputFrame(input);
  assert.equal(input.keys.has('KeyW'), true);
  assert.equal(input.mouse.buttons, 1);
  assert.equal(input.pressed.size, 0);
  assert.equal(input.mouse.dx, 0);
  assert.equal(input.mouse.wheel, 0);
  input.pressed.add('Space');
  input.mouse.pressed = 1;
  input.mouse.dx = 10;
  releaseInput(input);
  assert.equal(input.keys.size, 0);
  assert.equal(input.pressed.size, 0);
  assert.deepEqual(input.mouse, { dx: 0, dy: 0, buttons: 0, pressed: 0, wheel: 0 });
  assert.deepEqual(input.pads, [null]);
  assert.deepEqual(input.padPrev, [[]]);
  assert.notEqual(createInputState().keys, input.keys);
});
