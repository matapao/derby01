import assert from 'node:assert/strict';
import { test } from 'node:test';
import damage from '../data/damage.json' with { type: 'json' };
import {
  BODY_PANELS,
  collisionBodyDamage,
  createBodyworkState,
  bodyworkDetail,
  decodeBodyworkDetail,
  listPanelRepairs,
  panelRepairId,
  canRepairPanel,
  repairPanel,
  wreckBodyDamage,
  type BodyDamageHit,
  type BodyInventory,
} from '../src/gameplay/body-damage.ts';
import type { DamageZone } from '../src/gameplay/geometry.ts';
import type { DamageCause, GamePhase } from '../src/gameplay/model.ts';

const tuning = damage.bodywork;
function inventory(): BodyInventory {
  return {
    panels: [...BODY_PANELS],
    wheels: [
      [0.71, 1.281],
      [-0.7, 1.281],
      [0.71, -1.123],
      [-0.7, -1.123],
    ].map(([x = 0, z = 0]) => ({ attached: true, x, z, tyreHp: 100, flat: false, axleBroken: false })),
  };
}
function hit(overrides: Partial<BodyDamageHit> = {}): BodyDamageHit {
  return {
    alive: true,
    phase: 'playing',
    cause: 'crash',
    zone: 'lf',
    time: 10,
    amount: 4,
    impact: 8,
    local: { x: 0.71, y: 0.5, z: 1.281 },
    ...overrides,
  };
}

test('bumper-reduced collision damage first loosens a panel, then a later hit releases it', () => {
  const body = inventory(),
    state = createBodyworkState();
  const rawDamage = (8 - damage.crash.threshold) * damage.crash.per * damage.zones.lf;
  const afterBumper = rawDamage * (1 - damage.bumpers.crash);
  assert.ok(afterBumper >= tuning.panelLooseDamage && afterBumper < tuning.panelDamage);
  assert.equal(collisionBodyDamage(state, body, hit({ amount: afterBumper }), tuning).panel, null);
  assert.deepEqual(state.L_Door_Front, { wear: afterBumper, looseSince: 10, generation: 1 });
  assert.equal(
    collisionBodyDamage(state, body, hit({ amount: afterBumper, time: 10.4 }), tuning).panel,
    null,
  );
  assert.equal(
    collisionBodyDamage(state, body, hit({ amount: afterBumper, time: 10.8 }), tuning).panel,
    'L_Door_Front',
  );
});

test('a severe first hit always has a visible loose stage before any later detachment', () => {
  const state = createBodyworkState(),
    body = inventory();
  assert.equal(collisionBodyDamage(state, body, hit({ amount: 50, time: 0 }), tuning).panel, null);
  assert.deepEqual(state.L_Door_Front, { wear: 50, looseSince: 0, generation: 1 });
  assert.equal(collisionBodyDamage(state, body, hit({ amount: 50, time: 0.799 }), tuning).panel, null);
  assert.equal(
    collisionBodyDamage(state, body, hit({ amount: 50, time: 0.8 }), tuning).panel,
    'L_Door_Front',
  );
});

test('targeted collision wear is independent for each of the six panels', () => {
  const body = inventory(),
    state = createBodyworkState();
  const expected: Record<DamageZone, string> = {
    front: 'car_hood',
    rear: 'trunk',
    lf: 'L_Door_Front',
    rf: 'R_Door_Front',
    lr: 'L_Door_Back',
    rr: 'R_Door_Back',
  };
  for (const zone of Object.keys(expected) as DamageZone[]) {
    assert.equal(collisionBodyDamage(state, body, hit({ zone, amount: 12 }), tuning).panel, null);
    assert.equal(
      collisionBodyDamage(state, body, hit({ zone, amount: 12, time: 11 }), tuning).panel,
      expected[zone],
    );
  }
  assert.ok(BODY_PANELS.every((panel) => state[panel].looseSince === 10));
  body.panels = body.panels.filter((panel) => panel !== 'L_Door_Front');
  const before = structuredClone(state);
  assert.equal(collisionBodyDamage(state, body, hit({ time: 20, amount: 100 }), tuning).panel, null);
  assert.equal(collisionBodyDamage(state, body, hit({ zone: null, time: 20 }), tuning).panel, null);
  assert.deepEqual(state, before);
});

test('paintballs and non-collision damage never add panel wear or release metal', () => {
  const body = inventory(),
    state = createBodyworkState();
  for (const wheel of body.wheels) wheel.flat = true;
  for (const cause of ['gun', 'fire', 'landing'] satisfies DamageCause[])
    assert.deepEqual(collisionBodyDamage(state, body, hit({ cause, amount: 100, impact: 50 }), tuning), {
      panel: null,
      wheel: null,
    });
  assert.deepEqual(state, createBodyworkState());
});

test('soft or bumper-absorbed hits cannot loosen or release panels', () => {
  const body = inventory(),
    state = createBodyworkState();
  for (const overrides of [{ impact: tuning.panelImpact - 0.001 }, { amount: tuning.panelHit - 0.001 }]) {
    assert.equal(collisionBodyDamage(state, body, hit(overrides), tuning).panel, null);
    assert.deepEqual(state, createBodyworkState());
  }
  collisionBodyDamage(state, body, hit({ amount: 50 }), tuning);
  for (const overrides of [{ impact: tuning.panelImpact - 0.001 }, { amount: tuning.panelHit - 0.001 }])
    assert.equal(collisionBodyDamage(state, body, hit({ time: 12, ...overrides }), tuning).panel, null);
  assert.equal(
    collisionBodyDamage(
      state,
      body,
      hit({ time: 12, impact: tuning.panelImpact, amount: tuning.panelHit, cause: 'wall' }),
      tuning,
    ).panel,
    'L_Door_Front',
  );
});

test('loose and detached thresholds use collision wear and require a later collision', () => {
  const body = inventory(),
    state = createBodyworkState();
  collisionBodyDamage(state, body, hit({ amount: tuning.panelLooseDamage - 0.001 }), tuning);
  assert.equal(state.L_Door_Front.looseSince, null);
  collisionBodyDamage(state, body, hit({ amount: tuning.panelHit, time: 11 }), tuning);
  assert.equal(state.L_Door_Front.looseSince, 11);
  assert.equal(
    collisionBodyDamage(state, body, hit({ amount: tuning.panelHit, time: 20 }), tuning).panel,
    null,
  );
  assert.equal(
    collisionBodyDamage(state, body, hit({ amount: tuning.panelDamage, time: 20 }), tuning).panel,
    'L_Door_Front',
  );
});

test('non-playing, dead, malformed and unlocated collisions cannot change bodywork', () => {
  const body = inventory(),
    state = createBodyworkState();
  const phases: GamePhase[] = ['loading', 'menu', 'countdown', 'over', 'paused'];
  for (const phase of phases)
    assert.deepEqual(collisionBodyDamage(state, body, hit({ phase }), tuning), { panel: null, wheel: null });
  for (const overrides of [
    { alive: false },
    { amount: NaN },
    { amount: Infinity },
    { amount: -1 },
    { impact: NaN },
    { impact: Infinity },
    { time: NaN },
    { time: Infinity },
    { time: -1 },
    { time: 86401 },
    { local: null },
    { local: { x: NaN, y: 0.5, z: 1 } },
    { local: { x: 0, y: Infinity, z: 1 } },
    { local: { x: 0, y: 0.5, z: NaN } },
  ])
    assert.deepEqual(collisionBodyDamage(state, body, hit(overrides), tuning), { panel: null, wheel: null });
  assert.deepEqual(state, createBodyworkState());
});

test('hard local collisions can remove one damaged wheel but protect healthy tyres', () => {
  const body = inventory();
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, null);
  const wheel = body.wheels[0]!;
  wheel.tyreHp = tuning.wheelTyreHp;
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, 0);
  wheel.tyreHp += 0.001;
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, null);
  wheel.flat = true;
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, 0);
  wheel.flat = false;
  wheel.axleBroken = true;
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, 0);
  wheel.attached = false;
  assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(), tuning).wheel, null);
});

test('wheel loss requires its own impact, damage, height and distance boundaries', () => {
  const body = inventory();
  body.wheels[0]!.flat = true;
  for (const overrides of [
    { impact: tuning.wheelImpact - 0.001 },
    { amount: tuning.wheelHit - 0.001 },
    { local: { x: 0.71, y: tuning.wheelHeight + 0.001, z: 1.281 } },
    { local: { x: 0.71, y: -0.001, z: 1.281 } },
    { local: { x: 0.71, y: 0.5, z: 1.281 + tuning.wheelRadius + 0.001 } },
  ])
    assert.equal(collisionBodyDamage(createBodyworkState(), body, hit(overrides), tuning).wheel, null);
  assert.equal(
    collisionBodyDamage(
      createBodyworkState(),
      body,
      hit({
        impact: tuning.wheelImpact,
        amount: tuning.wheelHit,
        local: { x: 0.71, y: tuning.wheelHeight, z: 1.281 },
      }),
      tuning,
    ).wheel,
    0,
  );
});

test('wheel choice is nearest, deterministic on ties and bounded to four physical wheels', () => {
  const body = inventory();
  for (const wheel of body.wheels) wheel.flat = true;
  assert.equal(
    collisionBodyDamage(createBodyworkState(), body, hit({ local: { x: -0.7, y: 0.5, z: 1.281 } }), tuning)
      .wheel,
    1,
  );
  assert.equal(
    collisionBodyDamage(createBodyworkState(), body, hit({ local: { x: 0.005, y: 0.5, z: 1.281 } }), {
      ...tuning,
      wheelRadius: 2,
    }).wheel,
    0,
  );
  const extra = { ...body.wheels[0]!, x: 0, z: 0 };
  body.wheels = [...body.wheels.map((wheel) => ({ ...wheel, attached: false })), extra];
  assert.equal(
    collisionBodyDamage(createBodyworkState(), body, hit({ local: { x: 0, y: 0.5, z: 0 } }), tuning).wheel,
    null,
  );
});

test('wrecks reliably expose front seats and shed two wheels, skipping already missing parts', () => {
  const body = inventory();
  assert.deepEqual(wreckBodyDamage(body, tuning), {
    panels: ['L_Door_Front', 'R_Door_Front', 'car_hood', 'trunk'],
    wheels: [0, 3],
  });
  body.panels = body.panels.filter((panel) => panel !== 'L_Door_Front');
  body.wheels[0]!.attached = false;
  assert.deepEqual(wreckBodyDamage(body, tuning), {
    panels: ['R_Door_Front', 'car_hood', 'trunk', 'L_Door_Back'],
    wheels: [3, 1],
  });
});

test('wreck limits cannot request unbounded, duplicate or nonexistent debris', () => {
  const body = inventory();
  body.panels = [...body.panels, ...body.panels];
  body.wheels = [...body.wheels, ...body.wheels];
  const before = structuredClone(body);
  assert.deepEqual(wreckBodyDamage(body, { wreckPanels: 1e6, wreckWheels: 1e6 }), {
    panels: ['L_Door_Front', 'R_Door_Front', 'car_hood', 'trunk', 'L_Door_Back', 'R_Door_Back'],
    wheels: [0, 3, 1, 2],
  });
  assert.deepEqual(wreckBodyDamage(body, { wreckPanels: NaN, wreckWheels: -1 }), { panels: [], wheels: [] });
  collisionBodyDamage(createBodyworkState(), body, hit(), tuning);
  assert.deepEqual(body, before);
});

test('bodywork detail round-trips all six panel stages and preserves authority after migration', () => {
  const state = createBodyworkState();
  BODY_PANELS.forEach((panel, index) => {
    state[panel] = { wear: 6 + index, looseSince: index % 2 === 0 ? index : null, generation: index };
  });
  const decoded = decodeBodyworkDetail(bodyworkDetail(state), createBodyworkState());
  assert.deepEqual(decoded, state);
  const result = collisionBodyDamage(
    decoded,
    inventory(),
    hit({ zone: 'front', time: 20, amount: 12 }),
    tuning,
  );
  assert.equal(result.panel, 'car_hood');
  decoded.car_hood.wear = 0;
  assert.equal(state.car_hood.wear, 6);
});

test('optional or malformed bodywork detail preserves previous six-panel state', () => {
  const state = createBodyworkState();
  state.L_Door_Back = { wear: 8, looseSince: 4, generation: 1 };
  for (const raw of [
    undefined,
    null,
    [],
    42,
    'bad',
    {},
    { wear: [], looseSince: [] },
    { wear: new Array(7).fill(5), looseSince: new Array(7).fill(null) },
    { wear: new Array(6).fill(5) },
    { looseSince: new Array(6).fill(null) },
  ])
    assert.deepEqual(decodeBodyworkDetail(raw, state), state);
});

test('malformed bodywork entries are rejected independently and decoding never aliases input', () => {
  const previous = createBodyworkState();
  previous.car_hood = { wear: 8, looseSince: 1, generation: 1 };
  for (const invalid of [NaN, Infinity, -1, 1001, '10', null, {}, []]) {
    const raw = bodyworkDetail(previous);
    raw.wear[0] = invalid as number;
    assert.deepEqual(decodeBodyworkDetail(raw, previous), previous);
  }
  for (const invalid of [NaN, Infinity, -1, 86401, '10', undefined, {}, []]) {
    const raw = bodyworkDetail(previous);
    raw.looseSince[0] = invalid as number;
    assert.deepEqual(decodeBodyworkDetail(raw, previous), previous);
  }
  const raw = bodyworkDetail(previous);
  raw.wear[0] = NaN;
  raw.wear[1] = 9;
  raw.looseSince[1] = 2;
  const decoded = decodeBodyworkDetail(raw, previous);
  assert.deepEqual(decoded.car_hood, previous.car_hood);
  assert.deepEqual(decoded.trunk, { wear: 9, looseSince: 2, generation: 0 });
  raw.wear[1] = 100;
  assert.equal(decoded.trunk.wear, 9);
});

test('panel jobs list only loose attached panels and repair resets only the matching panel', () => {
  const state = createBodyworkState(),
    body = inventory();
  collisionBodyDamage(state, body, hit({ amount: 12 }), tuning);
  collisionBodyDamage(state, body, hit({ zone: 'front', amount: 12 }), tuning);
  const attached = body.panels.filter((name) => name !== 'car_hood');
  const jobs = listPanelRepairs(state, attached);
  assert.deepEqual(jobs, [{ name: 'L_Door_Front', generation: 1 }]);
  const repair = jobs[0]!;
  assert.equal(panelRepairId(repair), 'panel:L_Door_Front:1');
  assert.equal(canRepairPanel(state, attached, repair), true);
  assert.equal(repairPanel(state, attached, repair, 12, 1.5), true);
  assert.deepEqual(state.L_Door_Front, { wear: 0, looseSince: null, generation: 1 });
  assert.deepEqual(state.car_hood, { wear: 12, looseSince: 10, generation: 1 });
  assert.equal(repairPanel(state, attached, repair, 12, 1.5), false);
});

test('detached, already repaired and stale jobs cannot repair a new loose generation', () => {
  const state = createBodyworkState(),
    body = inventory();
  collisionBodyDamage(state, body, hit({ amount: 20 }), tuning);
  const old = listPanelRepairs(state, body.panels)[0]!;
  assert.equal(
    repairPanel(
      state,
      body.panels.filter((name) => name !== 'L_Door_Front'),
      old,
      12,
      1.5,
    ),
    false,
  );
  assert.equal(repairPanel(state, body.panels, old, 12, 1.5), true);
  collisionBodyDamage(state, body, hit({ amount: 20, time: 10 }), tuning);
  const fresh = listPanelRepairs(state, body.panels)[0]!;
  assert.equal(fresh.generation, 2);
  assert.notEqual(panelRepairId(old), panelRepairId(fresh));
  assert.equal(canRepairPanel(state, body.panels, old), false);
  assert.equal(repairPanel(state, body.panels, old, 12, 1.5), false);
  assert.equal(repairPanel(state, body.panels, fresh, 12, 1.5), true);
});

test('tightening requires finite minimum loose age and rejects early or invalid completion', () => {
  const state = createBodyworkState(),
    body = inventory();
  collisionBodyDamage(state, body, hit({ amount: 20 }), tuning);
  const repair = listPanelRepairs(state, body.panels)[0]!;
  const before = structuredClone(state);
  for (const [time, age] of [
    [11.499, 1.5],
    [9, 1.5],
    [NaN, 1.5],
    [Infinity, 1.5],
    [12, NaN],
    [12, Infinity],
    [12, -1],
  ]) {
    assert.equal(repairPanel(state, body.panels, repair, time!, age!), false);
    assert.deepEqual(state, before);
  }
  assert.equal(repairPanel(state, body.panels, repair, 11.5, 1.5), true);
});

test('bodywork detail preserves repair generation and rejects malformed generation tokens', () => {
  const state = createBodyworkState(),
    body = inventory();
  collisionBodyDamage(state, body, hit({ amount: 12 }), tuning);
  const decoded = decodeBodyworkDetail(bodyworkDetail(state), createBodyworkState());
  assert.equal(listPanelRepairs(decoded, body.panels)[0]?.generation, 1);
  const legacy = bodyworkDetail(state);
  delete legacy.generation;
  assert.equal(decodeBodyworkDetail(legacy, state).L_Door_Front.generation, 1);
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    const raw = bodyworkDetail(state);
    raw.generation![2] = value as number;
    assert.deepEqual(decodeBodyworkDetail(raw, state), state);
  }
  const raw = bodyworkDetail(state);
  raw.generation = [];
  assert.deepEqual(decodeBodyworkDetail(raw, state), state);
});

test('the largest bounded generation remains safe when a panel loosens again', () => {
  const state = createBodyworkState();
  state.L_Door_Front.generation = Number.MAX_SAFE_INTEGER;
  collisionBodyDamage(state, inventory(), hit({ amount: 12 }), tuning);
  assert.equal(state.L_Door_Front.generation, 0);
  assert.deepEqual(decodeBodyworkDetail(bodyworkDetail(state), createBodyworkState()), state);
});
