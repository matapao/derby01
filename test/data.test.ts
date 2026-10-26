// The game's live data (src/data.ts): a revision is put in place inside the same objects, a block that
// doesn't fit its schema keeps what it was, and what is worked out from the data is worked out again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D, dataRevision, onData, prefetchRevision, useData, useLoaded, useRevision } from '../src/data.ts';

test('a revision goes into the same objects, and the derived tables follow', () => {
  const engine = D.physics.engine,
    before = engine.top;
  let derived = 0;
  onData(() => {
    derived = D.physics.engine.top * 2;
  });
  assert.equal(derived, before * 2);
  const physics = structuredClone(D.physics);
  physics.engine.top = 31;
  assert.deepEqual(useData({ physics }, 'r1'), []);
  assert.equal(engine.top, 31, 'a module that kept D.physics.engine sees the new value');
  assert.equal(derived, 62);
  assert.equal(dataRevision(), 'r1');
  useData({}, '');
  assert.equal(engine.top, before, 'blocks not given go back to the built ones');
});

test('a block that does not fit its schema is refused, the others are used', () => {
  const rounds = { ...D.rounds, countdown: 99 },
    car = { ...structuredClone(D.car), hp: 80 };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const problems = useData({ rounds, car }, 'r2');
    assert.ok(
      problems.some((p) => /^rounds\/countdown/.test(p)),
      problems.join('\n'),
    );
    assert.equal(D.rounds.countdown, 3.5);
    assert.equal(D.car.hp, 80);
  } finally {
    console.warn = warn;
    useData({}, '');
  }
});

test('a revision is read through zirbel-net once, and put in place when a round asks for it', async () => {
  const asked: string[] = [];
  const net = {
    async data(file: string, rev?: string): Promise<unknown> {
      asked.push(`${rev}/${file}`);
      if (file === 'rounds.json') return { ...D.rounds, between: 11 };
      throw new Error('not in this revision');
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(useLoaded('r3'), false, 'not read yet');
    await Promise.all([prefetchRevision(net, 'r3'), prefetchRevision(net, 'r3')]);
    assert.equal(asked.filter((a) => a === 'r3/rounds.json').length, 1, 'read once');
    assert.equal(D.rounds.between, 7, 'read, not yet played');
    assert.equal(useLoaded('r3'), true);
    assert.equal(D.rounds.between, 11);
    assert.equal(D.car.hp, 100, 'blocks the revision lacks stay as built');
    assert.equal(await useRevision(net, ''), true);
    assert.equal(D.rounds.between, 7);
    assert.equal(
      await useRevision({}, 'r4'),
      false,
      'without zirbel-net to read it, the data stays as it is',
    );
  } finally {
    console.warn = warn;
    useData({}, '');
  }
});
