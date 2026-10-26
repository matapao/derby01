import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMechanicController } from '../src/gameplay/mechanic-controller.ts';
import { participantState, resetSeatState } from '../src/gameplay/participants.ts';
import { createPlayerCommands, type IndexedRequest } from '../src/gameplay/player-commands.ts';
import { type MechanicTask } from '../src/gameplay/minigames.ts';
import { input, minigameFixture, task } from './minigame-fixture.ts';

function fixture() {
  const base = minigameFixture(),
    human = participantState(0, 'kbm', base.car, 3);
  let tasks: MechanicTask[] = [task('fuel')];
  const fixes: string[] = [],
    requests: IndexedRequest[] = [];
  const commands = createPlayerCommands((request) => requests.push(request));
  const controller = createMechanicController({
    games: base.games,
    canFuel: base.canFuel,
    tasks: () => tasks,
    gameType: (job) => (job.kind === 'fuel' ? 'pour' : 'nuts'),
    fix: (player, job) => {
      fixes.push(job.id);
      commands.askFix(player, job);
      tasks = [];
    },
    poured: commands.pourInto,
    sound: (sound) => base.effects.push(sound),
  });
  return {
    ...base,
    human,
    fixes,
    requests,
    commands,
    ...controller,
    setTasks: (next: MechanicTask[]) => {
      tasks = next;
    },
  };
}
test('missing spares and stale touch selections cannot start a job', () => {
  const f = fixture();
  f.setTasks([{ ...task('fuel'), need: 'fuel can' }]);
  f.updateHumanMechanic(f.human, input({ pick: 'gone', aP: true }), 0.1);
  assert.equal(f.human.mech?.game, null);
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  assert.equal(f.human.mech?.game, null);
  assert.equal(f.human.mech?.msgBad, true);
  assert.deepEqual(f.fixes, []);
  assert.deepEqual(f.requests, []);
});
test('cancelling a fresh can costs nothing, while a used can is flushed and consumed once', () => {
  const f = fixture();
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.dropJob(f.human);
  assert.deepEqual(f.fixes, []);
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.updateHumanMechanic(f.human, input({ a: true }), 0.25);
  const poured = f.car.sys.fuel;
  f.updateHumanMechanic(f.human, input({ bP: true }), 0.1);
  f.dropJob(f.human);
  assert.deepEqual(f.fixes, ['fuel']);
  assert.deepEqual(f.requests, [
    { i: 0, a: 'pour', d: poured, spill: false },
    { i: 0, a: 'fix', task: 'fuel' },
  ]);
  assert.equal(f.human.mech?.game, null);
});
test('a pour continues after the task disappears and completes exactly once when the can empties', () => {
  const f = fixture();
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.setTasks([]);
  for (let n = 0; n < 50; n++) f.updateHumanMechanic(f.human, input({ a: true }), 0.1);
  assert.deepEqual(f.fixes, ['fuel']);
  assert.equal(f.car.sys.fuel, f.canFuel());
  assert.equal(f.human.mech?.game, null);
});
test('a disappearing non-fuel task is cancelled without consuming anything', () => {
  const f = fixture();
  f.setTasks([task('tire')]);
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.setTasks([]);
  f.updateHumanMechanic(f.human, input(), 0.1);
  assert.equal(f.human.mech?.game, null);
  assert.deepEqual(f.fixes, []);
});
test('seat changes discard role-specific state after settling an in-progress pour', () => {
  const f = fixture();
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.updateHumanMechanic(f.human, input({ a: true }), 0.25);
  f.human.jamGame = f.games.unjam.init();
  f.human.aim = { yaw: 1, pitch: 1 };
  f.human.mouseSteer = 1;
  f.dropJob(f.human);
  resetSeatState(f.human, f.car, 1);
  assert.equal(f.human.seat, 1);
  assert.equal(f.human.mech, null);
  assert.equal(f.human.jamGame, null);
  assert.equal(f.human.aim, null);
  assert.equal(f.human.mouseSteer, 0);
  assert.deepEqual(f.fixes, ['fuel']);
});
test('participants do not share mechanic or jam state', () => {
  const f = fixture(),
    second = participantState(1, 'arrows', f.car, 3);
  f.updateHumanMechanic(f.human, input({ aP: true }), 0.1);
  f.updateHumanMechanic(second, input(), 0.1);
  assert.notEqual(f.human.mech, second.mech);
  assert.equal(second.mech?.game, null);
});

function pendingFixture(acceptAfter = Infinity) {
  const base = minigameFixture();
  const human = participantState(0, 'kbm', base.car, 3);
  const original = task('panel');
  assert.equal(original.kind, 'panel');
  let state: 'loose' | 'tight' | 'detached' = 'loose';
  let generation = original.generation;
  let applied = 0;
  const requests: MechanicTask[] = [];
  const controller = createMechanicController({
    games: base.games,
    canFuel: base.canFuel,
    tasks: () => (state === 'loose' ? [{ ...original, generation, id: `panel:car_hood:${generation}` }] : []),
    gameType: () => 'nuts',
    fix: (_human, job) => {
      requests.push(structuredClone(job));
      if (
        requests.length >= acceptAfter &&
        job.kind === 'panel' &&
        job.generation === generation &&
        state === 'loose'
      ) {
        state = 'tight';
        applied++;
      }
      return 'pending';
    },
    fixStatus: (_human, job) =>
      job.kind !== 'panel' || job.generation !== generation || state === 'detached'
        ? 'cancelled'
        : state === 'tight'
          ? 'done'
          : 'waiting',
    poured: () => {},
    sound: (sound) => base.effects.push(sound),
  });
  const update = (dt: number, frame = input()) => controller.updateHumanMechanic(human, frame, dt);
  function completeGame() {
    update(0.01, input({ aP: true }));
    const game = human.mech?.game;
    assert.equal(game?.type, 'nuts');
    for (const direction of game.seq) update(0.01, input({ tap: direction }));
    for (let n = 0; n < game.taps; n++) update(0.01, input({ aP: true }));
    update(game.minTime - game.elapsed + 0.001);
    assert.equal(human.mech?.game, null);
    assert.ok(human.mech?.pending);
  }
  return {
    ...base,
    human,
    requests,
    update,
    completeGame,
    ...controller,
    applied: () => applied,
    detach: () => {
      state = 'detached';
    },
    loosenAgain: () => {
      generation++;
      state = 'loose';
    },
    confirm: () => {
      state = 'tight';
    },
  };
}

test('replica completion waits for confirmation and retries a rejected request without double credit', () => {
  const f = pendingFixture(2);
  f.completeGame();
  assert.equal(f.requests.length, 1, 'first completion is rejected by the host cooldown');
  assert.equal(f.applied(), 0);
  assert.equal(f.human.mech?.msg, 'Waiting for repair…');
  assert.equal(f.effects.includes('ok'), false);
  f.update(0.49, input({ aP: true, pick: f.requests[0]!.id }));
  assert.equal(f.requests.length, 1);
  assert.equal(f.human.mech?.game, null, 'waiting input cannot start another job');
  f.update(0.01);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1], 'retry retains the original identity and generation');
  assert.equal(f.applied(), 1);
  assert.equal(f.effects.includes('ok'), false, 'sending a retry is not confirmation');
  f.update(0.01);
  assert.equal(f.human.mech?.pending, null);
  assert.equal(f.human.mech?.msg, 'FIXED!');
  assert.equal(f.human.mech?.msgBad, false);
  assert.equal(f.effects.filter((effect) => effect === 'ok').length, 1);
  f.update(2);
  assert.equal(f.applied(), 1);
  assert.equal(f.requests.length, 2);
});

test('pending repairs cancel on detachment or a newer panel generation without retry or credit', () => {
  for (const cancellation of ['detach', 'loosenAgain'] as const) {
    const f = pendingFixture();
    f.completeGame();
    f[cancellation]();
    f.update(0.5);
    assert.equal(f.human.mech?.pending, null);
    assert.equal(f.human.mech?.msg, 'Panel lost — repair cancelled');
    assert.equal(f.human.mech?.msgBad, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.applied(), 0);
    assert.equal(f.effects.includes('ok'), false);
  }
});

test('dropping a pending repair or changing seats stops every future retry', () => {
  for (const cancel of ['drop', 'back', 'seat'] as const) {
    const f = pendingFixture();
    f.completeGame();
    if (cancel === 'back') f.update(0.1, input({ bP: true }));
    else f.dropJob(f.human);
    if (cancel === 'seat') resetSeatState(f.human, f.car, 1);
    for (let n = 0; n < 20; n++) f.update(0.5);
    assert.equal(f.human.mech?.pending, null);
    assert.equal(f.requests.length, 1);
    assert.equal(f.applied(), 0);
  }
});

test('unconfirmed repair retries are bounded and eventually let the player try again', () => {
  const f = pendingFixture();
  f.completeGame();
  for (let n = 0; n < 16; n++) f.update(0.5);
  assert.equal(f.requests.length, 16, 'one original request and fifteen bounded retries');
  assert.equal(f.human.mech?.pending, null);
  assert.equal(f.human.mech?.msg, 'Could not confirm — try again');
  assert.equal(f.human.mech?.msgBad, true);
  assert.equal(f.effects.includes('ok'), false);
  f.update(1);
  assert.equal(f.requests.length, 16);
  const stalled = pendingFixture();
  stalled.completeGame();
  stalled.update(9);
  assert.equal(stalled.requests.length, 1, 'a stalled frame cannot burst retries');
});

test('confirmation wins over the pending timeout and invalid time never advances retries', () => {
  const f = pendingFixture();
  f.completeGame();
  for (const dt of [0, -1, NaN, Infinity]) f.update(dt);
  assert.equal(f.human.mech?.pending?.elapsed, 0);
  assert.equal(f.requests.length, 1);
  f.confirm();
  f.update(9);
  assert.equal(f.human.mech?.msg, 'FIXED!');
  assert.equal(f.requests.length, 1);
});

test('adapters returning pending must provide a confirmation status reader', () => {
  const base = minigameFixture(),
    human = participantState(0, 'kbm', base.car, 3);
  const controller = createMechanicController({
    games: base.games,
    canFuel: base.canFuel,
    tasks: () => [task('panel')],
    gameType: () => 'nuts',
    fix: () => 'pending',
    poured: () => {},
    sound: () => {},
  });
  controller.updateHumanMechanic(human, input({ aP: true }), 0.01);
  const game = human.mech?.game;
  assert.equal(game?.type, 'nuts');
  for (const direction of game.seq) controller.updateHumanMechanic(human, input({ tap: direction }), 0.01);
  for (let n = 0; n < game.taps; n++) controller.updateHumanMechanic(human, input({ aP: true }), 0.01);
  assert.throws(() => controller.updateHumanMechanic(human, input(), 2), /fixStatus adapter/);
});
