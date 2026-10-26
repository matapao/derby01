import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSetup } from '../src/setup.ts';

const rules = {
  devices: {
    kbm: { uses: ['keys', 'mouse'] },
    keys: { uses: ['keys'] },
    mouse: { uses: ['mouse'] },
    pad0: { uses: ['pad0'] },
  },
  defaultKits: ['stock', 'rally'],
  isKit: (value: unknown) => value === 'stock' || value === 'rally',
  maxCars: 8,
  newMapSeed: () => 42,
};
test('saved settings reject malformed roots and unsupported car counts', () => {
  for (const value of [null, false, [], {}, { cars: [] }, { cars: [{}] }, { cars: Array(9).fill({}) }]) {
    assert.equal(decodeSetup(value, rules), null);
  }
});
test('saved settings rebuild teams, bound fields and remove overlapping or unknown devices', () => {
  const saved = {
    botSkill: 99,
    mapSeed: Infinity,
    cars: [
      { team: 999, kit: '__proto__', seats: ['kbm', 'keys', 'mouse', 'peer:7'] },
      { team: -1, kit: 'stock', seats: ['pad0', 'pad0', '__proto__', null] },
    ],
  };
  const before = structuredClone(saved);
  assert.deepEqual(decodeSetup(saved, rules), {
    botSkill: 1,
    mapSeed: 42,
    cars: [
      { team: 0, kit: 'stock', seats: ['kbm', 'bot', 'bot', 'bot'] },
      { team: 1, kit: 'stock', seats: ['pad0', 'bot', 'bot', 'bot'] },
    ],
  });
  assert.deepEqual(saved, before, 'decoding never mutates its input');
});
test('valid settings survive while malformed cars receive safe defaults', () => {
  assert.deepEqual(
    decodeSetup(
      { botSkill: 2, mapSeed: 99999, cars: [null, { kit: 'rally', seats: ['keys', 'mouse', 'bot', 'bot'] }] },
      rules,
    ),
    {
      botSkill: 2,
      mapSeed: 99999,
      cars: [
        { team: 0, kit: 'stock', seats: ['bot', 'bot', 'bot', 'bot'] },
        { team: 1, kit: 'rally', seats: ['keys', 'mouse', 'bot', 'bot'] },
      ],
    },
  );
});
