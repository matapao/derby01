import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleTransitions, routeRoomMessage, whenActive } from '../src/net/router.ts';
import { requiredBinding } from '../src/gameplay/binding.ts';
import { createPlayerCommands, type IndexedRequest } from '../src/gameplay/player-commands.ts';
import { MSG } from '../src/net/protocol.ts';
import type { Role } from '../src/net/role.ts';

function roles(initial: Role) {
  let role = initial;
  const calls: string[] = [];
  const router = createRoleTransitions({
    current: () => role,
    set: (next) => {
      role = next;
      calls.push(`role:${next}`);
    },
    hostStart: (takeover) => calls.push(`startHost:${takeover}`),
    hostStop: () => calls.push('stopHost'),
    hostLost: () => calls.push('hostLost'),
    replicaStart: () => calls.push('startReplica'),
    replicaStop: () => calls.push('stopReplica'),
    replicaUi: (on) => calls.push(`replicaUi:${on}`),
    toMenu: () => calls.push('menu'),
    clock: () => calls.push('clock'),
  });
  return { ...router, calls, role: () => role };
}
test('host takeover stops the replica before publishing and starting the new authority', () => {
  const r = roles('replica');
  r.decide(true);
  assert.deepEqual(r.calls, ['stopReplica', 'role:host', 'replicaUi:false', 'startHost:true', 'clock']);
  r.calls.length = 0;
  r.decide(true);
  assert.deepEqual(r.calls, [], 'duplicate host events must not restart the game');
});
test('host demotion stops authority before starting replica state', () => {
  const r = roles('host');
  r.decide(false);
  assert.deepEqual(r.calls, ['stopHost', 'role:replica', 'replicaUi:true', 'startReplica', 'clock']);
});
test('offline startup and disconnect preserve the intended lifecycle for each role', () => {
  const fresh = roles('offline');
  fresh.decide(true);
  assert.ok(fresh.calls.includes('startHost:false'));
  const host = roles('host');
  host.disconnected();
  assert.deepEqual(host.calls, ['role:offline', 'replicaUi:false', 'hostLost', 'clock']);
  const replica = roles('replica');
  replica.disconnected();
  assert.deepEqual(replica.calls, ['role:offline', 'replicaUi:false', 'stopReplica', 'menu', 'clock']);
});
test('room routing accepts only control/ask on a host and authority messages on a replica', () => {
  const calls: string[] = [],
    message = { payload: 'same reader' };
  const handlers = {
    hostControls: (from: number, received: typeof message) => {
      assert.equal(received, message);
      calls.push(`control:${from}`);
    },
    hostAsk: (from: number) => {
      calls.push(`ask:${from}`);
    },
    replicaMessage: (type: number) => {
      calls.push(`replica:${type}`);
    },
  };
  routeRoomMessage('host', 2, 1, MSG.ctrl, message, handlers);
  routeRoomMessage('host', 2, 1, MSG.ask, message, handlers);
  routeRoomMessage('host', 2, 1, MSG.snap, message, handlers);
  routeRoomMessage('replica', 2, 1, MSG.snap, message, handlers);
  routeRoomMessage('replica', 1, 1, MSG.snap, message, handlers);
  routeRoomMessage('offline', 1, 1, MSG.ask, message, handlers);
  assert.deepEqual(calls, ['control:2', 'ask:2', `replica:${MSG.snap}`]);
});
test('late callbacks from a replaced connection cannot affect the new session', () => {
  const old = {},
    replacement = {};
  let current = old,
    changes = 0;
  const callback = whenActive(
    () => current === old,
    (amount: number) => {
      changes += amount;
    },
  );
  callback(1);
  current = replacement;
  callback(100);
  assert.equal(changes, 1);
});
test('a revision that finishes loading after session replacement cannot redraw the new room', async () => {
  const old = {},
    replacement = {};
  let current = old,
    redraws = 0;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const completed = pending.then(
    whenActive(
      () => current === old,
      () => {
        redraws++;
      },
    ),
  );
  current = replacement;
  finish();
  await completed;
  assert.equal(redraws, 0);
});
test('player commands flush fuel before consuming the can and cannot resend old deltas', () => {
  const sent: IndexedRequest[] = [],
    commands = createPlayerCommands((request) => sent.push(request));
  const player = { localIndex: 2 };
  commands.pourInto(player, 4);
  commands.pourInto(player, 8);
  commands.pourInto(player, -10);
  commands.pourInto(player, NaN);
  commands.pourInto(player, Infinity);
  commands.askFix(player, { id: 'fuel' });
  commands.sendPour(player);
  assert.deepEqual(sent, [
    { i: 2, a: 'pour', d: 12, spill: true },
    { i: 2, a: 'fix', task: 'fuel' },
  ]);
});
test('composition bindings fail before boot and cannot be silently replaced', () => {
  const binding = requiredBinding<{ pause(): void }>('Lifecycle');
  assert.throws(() => binding.get(), /before boot/);
  const first = { pause() {} };
  binding.bind(first);
  assert.equal(binding.get(), first);
  assert.throws(() => binding.bind({ pause() {} }), /already bound/);
  assert.equal(binding.get(), first);
});
