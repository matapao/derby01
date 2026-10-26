import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reader, Writer } from '../vendor/zirbel-net/codec.ts';
import { defineEffect, FX, recordInto, recorded, replayEffects, share } from '../src/net/effects.ts';
import { withSeed } from '../src/net/seeded.ts';

const played: { id: number; random: number }[] = [];
function take(id: number): void {
  if (share(FX.takeDrop, take, [id])) return;
  played.push({ id, random: Math.random() });
}
defineEffect(FX.takeDrop, take, {
  write(writer, [id]) {
    writer.u32(id);
  },
  read(reader) {
    const id = reader.u32();
    return id < 100 ? [id] : null;
  },
});
afterEach(() => {
  recordInto(null);
  played.length = 0;
});

test('recording and replay preserve arguments and seeded presentation randomness', () => {
  const random = Math.random;
  const writer = new Writer();
  recordInto(writer);
  take(12);
  take(37);
  assert.equal(recorded(), 2);
  const host = [...played];
  assert.equal(Math.random, random);
  played.length = 0;
  recordInto(null);
  replayEffects(new Reader(writer.view()));
  assert.deepEqual(played, host);
  assert.equal(Math.random, random);
});

test('truncated and rejected effects never reach the renderer', () => {
  const truncated = new Writer().u8(FX.takeDrop).u32(42).u8(1);
  replayEffects(new Reader(truncated.view()));
  assert.equal(played.length, 0);
  const messages = new Writer().u8(FX.takeDrop).u32(42).u32(1000).u8(FX.takeDrop).u32(43).u32(7);
  replayEffects(new Reader(messages.view()));
  assert.deepEqual(
    played.map((event) => event.id),
    [7],
  );
});

test('unknown ids stop a batch and caller limits bound playback', () => {
  const unknown = new Writer().u8(255).u32(42).u8(FX.takeDrop).u32(42).u32(1);
  replayEffects(new Reader(unknown.view()));
  assert.equal(played.length, 0);
  const messages = new Writer().u8(FX.takeDrop).u32(42).u32(1).u8(FX.takeDrop).u32(43).u32(2);
  replayEffects(new Reader(messages.view()), 1);
  assert.deepEqual(
    played.map((event) => event.id),
    [1],
  );
});

test('an unknown trailing id cannot bypass the per-second replay budget', (t) => {
  const now = performance.now();
  t.mock.method(performance, 'now', () => now);
  const messages = new Writer();
  for (let i = 0; i < 100; i++) messages.u8(FX.takeDrop).u32(42).u32(7);
  messages.u8(255).u32(43);

  for (let i = 0; i < 10; i++) replayEffects(new Reader(messages.view()));

  assert.ok(played.length > 0, 'valid prefix effects still play');
  assert.ok(played.length <= 600, 'all messages share the fixed-time replay allowance');
});

test('duplicate registration and mismatched recording functions fail explicitly', () => {
  assert.throws(
    () =>
      defineEffect(FX.takeDrop, take, {
        write() {},
        read() {
          return [1];
        },
      }),
    /defined twice/,
  );
  recordInto(new Writer());
  assert.throws(() => share(FX.takeDrop, () => {}, [1]), /isn't defined for this function/);
  assert.equal(recorded(), 0);
});

test('seed restoration survives a presentation exception', () => {
  const random = Math.random;
  assert.throws(
    () =>
      withSeed(123, () => {
        throw new Error('draw failed');
      }),
    /draw failed/,
  );
  assert.equal(Math.random, random);
});
