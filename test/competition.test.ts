import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANONYMOUS_METRICS,
  createCompetition,
  decodeRoundSummary,
  mergeAnonymousRecords,
  roundRecords,
  type TeamDefinition,
} from '../src/gameplay/competition.ts';
import { precisionAction, precisionResult } from '../src/gameplay/minigame-precision.ts';
import { advanceMiniGame } from '../src/gameplay/minigames.ts';
import { createMechanicController } from '../src/gameplay/mechanic-controller.ts';
import { participantState } from '../src/gameplay/participants.ts';
import { input, minigameFixture, task } from './minigame-fixture.ts';

const teams: TeamDefinition[] = [
  { team: 0, name: 'Red', constructor: 'Rally' },
  { team: 1, name: 'Blue', constructor: 'Muscle' },
  { team: 2, name: 'Green', constructor: 'Rally' },
];
const driver = { id: 'local:0', name: 'Driver' };
const mechanic = { id: 'peer:7:0', name: 'Mechanic' };
function fixture() {
  const competition = createCompetition();
  competition.begin(1, teams, [100, 0, 0]);
  return competition;
}

test('round facts use point deltas, elapsed simulation and the player actually driving', () => {
  const competition = fixture();
  const sample = { team: 0, alive: true, speedMps: 10, burnS: 2.3, driver, occupants: [driver, mechanic] };
  competition.sample([sample], 0.5);
  competition.sample([{ ...sample, alive: false }], 0.5);
  for (const dt of [NaN, Infinity, -1, 0, 5]) competition.sample([sample], dt);
  competition.burn(0, driver, 2.45);
  const summary = competition.finish(4, [150, 0, 0], 0);
  assert.ok(summary);
  const red = summary.teams.find((team) => team.team === 0);
  assert.equal(red?.points, 50);
  assert.equal(red?.topSpeedKmh, 36);
  assert.equal(red?.distanceM, 5);
  assert.equal(red?.survivalS, 0.5);
  assert.equal(red?.longestBurnS, 2.45);
  assert.equal(summary.players.find((player) => player.id === driver.id)?.distanceM, 5);
  assert.equal(summary.players.find((player) => player.id === mechanic.id)?.distanceM, 0);
  assert.equal(summary.players.find((player) => player.id === mechanic.id)?.survivalS, 0.5);
  assert.equal(red?.accuracy, null);
  assert.equal(red?.precision, null);
});

test('mechanics championship measures applied jobs, health and fuel without inventing precision', () => {
  const competition = fixture();
  competition.repair(0, mechanic, 20);
  competition.fuel(0, mechanic, 30);
  competition.precision(0, mechanic, 3, 5);
  competition.precision(0, mechanic, 6, 5);
  competition.precision(0, mechanic, NaN, 1);
  competition.fuel(0, mechanic, -5);
  const result = competition.finish(10, [100, 0, 0], 1);
  assert.ok(result);
  assert.deepEqual(result.mechanics[0], {
    team: 0,
    name: 'Red',
    jobs: 1,
    repairs: 20,
    fuel: 30,
    precision: 60,
    precisionAttempts: 5,
    points: 13.5,
    totalPoints: 13.5,
  });
  assert.equal(result.mechanics.find((row) => row.team === 1)?.precision, null);
  assert.equal(result.players[0]?.jobs, 1);
  assert.equal(result.players[0]?.precision, 60);
});

test('session constructor and mechanic standings accumulate once per completed round', () => {
  const competition = fixture();
  competition.repair(0, mechanic, 20);
  const first = competition.finish(10, [150, 0, 30], 1);
  assert.ok(first);
  assert.deepEqual(first.constructors, [
    { name: 'Rally', points: 33, wins: 0, rounds: 1 },
    { name: 'Muscle', points: 25, wins: 1, rounds: 1 },
  ]);
  assert.equal(competition.finish(99, [999, 999, 999], 0), first, 'finish is idempotent');
  competition.begin(2, teams, [150, 0, 30]);
  competition.repair(0, mechanic, 20);
  const second = competition.finish(10, [180, 20, 40], 0);
  assert.ok(second);
  assert.equal(second.mechanics[0]?.totalPoints, 24);
  assert.deepEqual(second.constructors, [
    { name: 'Rally', points: 73, wins: 1, rounds: 2 },
    { name: 'Muscle', points: 43, wins: 1, rounds: 2 },
  ]);
  competition.begin(1, teams, [0, 0, 0]);
  const reset = competition.finish(1, [0, 0, 0], 0);
  assert.equal(reset?.mechanics[0]?.totalPoints, 0, 'a new session starts a new championship');
  assert.equal(reset?.constructors[0]?.rounds, 1);
});

test('anonymous records keep only ten bounded numeric values per declared metric', () => {
  const board = mergeAnonymousRecords(
    {
      round_points: [20, '100', NaN, -2, ...Array.from({ length: 20 }, (_, i) => i)],
      paint_accuracy: [100, 101],
      name: 'Private name',
      instance: 'room',
      date: 'today',
    },
    [{ metric: 'round_points', value: 50 }],
  );
  assert.deepEqual(board.round_points, [50, 20, 19, 18, 17, 16, 15, 14, 13, 12]);
  assert.deepEqual(board.paint_accuracy, [100]);
  assert.deepEqual(Object.keys(board), [...ANONYMOUS_METRICS]);
  const saved = JSON.stringify(board);
  for (const privateValue of ['Private name', 'instance', 'room', 'today', 'date'])
    assert.ok(!saved.includes(privateValue));
  assert.deepEqual(mergeAnonymousRecords(JSON.parse(saved), []), board);
});

test('a replacement authority continues validated championship totals without copying unfinished counters', () => {
  const oldAuthority = fixture();
  oldAuthority.repair(0, mechanic, 20);
  const first = oldAuthority.finish(10, [150, 0, 30], 1);
  const received = decodeRoundSummary(first);
  assert.ok(received);
  const replacement = createCompetition(received);
  replacement.begin(2, teams, [150, 0, 30]);
  replacement.repair(0, mechanic, 20);
  const second = replacement.finish(10, [180, 20, 40], 0);
  assert.ok(second);
  assert.equal(second.mechanics[0]?.jobs, 1, 'round facts count only the replacement round');
  assert.equal(second.mechanics[0]?.totalPoints, 24);
  assert.deepEqual(second.constructors, [
    { name: 'Rally', points: 73, wins: 1, rounds: 2 },
    { name: 'Muscle', points: 43, wins: 1, rounds: 2 },
  ]);
  assert.equal(first?.constructors[0]?.points, 33, 'seeding does not mutate the received report');
  replacement.begin(1, teams, [0, 0, 0]);
  const freshMatch = replacement.finish(1, [0, 0, 0], 0);
  assert.equal(freshMatch?.mechanics[0]?.totalPoints, 0);
  assert.equal(freshMatch?.constructors[0]?.rounds, 1);
});

test('accuracy records require enough measured shots and mechanic attempts', () => {
  const competition = fixture();
  for (let shot = 0; shot < 10; shot++) competition.shot(0, driver);
  for (let hit = 0; hit < 5; hit++) competition.hit(0, driver);
  competition.precision(0, mechanic, 4, 4);
  const result = competition.finish(10, [100, 0, 0], 0);
  assert.ok(result);
  assert.equal(result.teams[0]?.accuracy, 50);
  const records = roundRecords(result);
  assert.equal(records.find((record) => record.metric === 'paint_accuracy')?.value, 50);
  assert.equal(
    records.find((record) => record.metric === 'mechanic_precision'),
    undefined,
  );
});

test('room summary decoding rebuilds bounded fields and rejects corrupt or unrelated teams', () => {
  const competition = fixture();
  competition.shot(0, driver);
  competition.hit(0, driver);
  const summary = competition.finish(10, [100, 0, 0], 0);
  assert.ok(summary);
  assert.deepEqual(decodeRoundSummary({ ...summary, unwanted: 'ignored' }), summary);
  assert.equal(decodeRoundSummary({ ...summary, duration: Infinity }), null);
  assert.equal(decodeRoundSummary({ ...summary, teams: Array(9).fill(summary.teams[0]) }), null);
  assert.equal(decodeRoundSummary({ ...summary, players: [{ ...summary.players[0], team: 7 }] }), null);
  assert.equal(
    decodeRoundSummary({ ...summary, teams: summary.teams.map((row) => ({ ...row, name: 'x'.repeat(65) })) }),
    null,
  );
  assert.equal(
    decodeRoundSummary({ ...summary, teams: summary.teams.map((row) => ({ ...row, hits: 100 })) }),
    null,
  );
  assert.throws(() => competition.begin(3, [teams[0]!, teams[0]!], []), /Duplicate/);
});

test('timed minigame precision records actual hits and misses, excluding idle and continuous actions', () => {
  const f = minigameFixture();
  const game = f.active('hammer');
  game.t = 0.49;
  game.speed = 1;
  game.zone = 0.5;
  const tap = input({ aP: true });
  const good = precisionAction(game, tap, 0.01);
  assert.ok(good);
  advanceMiniGame(f.games, game, tap, 0.01, f.car);
  assert.equal(precisionResult(good, game), 1);
  game.t = 0;
  game.zone = 0.9;
  const miss = precisionAction(game, tap, 0.01);
  assert.ok(miss);
  advanceMiniGame(f.games, game, tap, 0.01, f.car);
  assert.equal(precisionResult(miss, game), 0);
  assert.equal(precisionAction(game, input(), 0.01), null);
  for (const kind of ['glue', 'dial', 'spray', 'pour'] as const)
    assert.equal(precisionAction(f.active(kind), tap, 0.01), null);
  const nuts = f.active('nuts');
  nuts.lock = 1;
  assert.equal(
    precisionAction(nuts, input({ tap: 'up' }), 0.01),
    null,
    'locked input is not an accepted attempt',
  );
  const glass = f.active('glass');
  assert.equal(precisionAction(glass, tap, 0.01), null, 'knocking out glass is not a timing challenge');
});

test('mechanic controller emits measured action quality without changing completion ownership', () => {
  const f = minigameFixture();
  const human = participantState(0, 'keys', f.car, 3);
  const quality: number[] = [];
  let fixes = 0;
  const controller = createMechanicController({
    games: f.games,
    tasks: () => [task('axle')],
    gameType: () => 'hammer',
    canFuel: f.canFuel,
    fix: () => {
      fixes++;
    },
    poured() {},
    sound() {},
    precision: (_human, correct) => {
      quality.push(correct);
    },
  });
  controller.updateHumanMechanic(human, input({ aP: true }), 0.01);
  const game = human.mech?.game;
  assert.ok(game?.type === 'hammer');
  game.t = 0.49;
  game.speed = 1;
  game.zone = 0.5;
  controller.updateHumanMechanic(human, input({ aP: true }), 0.01);
  game.t = 0;
  game.zone = 0.9;
  controller.updateHumanMechanic(human, input({ aP: true }), 0.01);
  controller.updateHumanMechanic(human, input({ bP: true }), 0.01);
  assert.deepEqual(quality, [1, 0]);
  assert.equal(fixes, 0, 'measurement does not complete or consume a cancelled job');
});

test('every published anonymous metric is declared without player, room or date labels', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../zirbel.json', import.meta.url), 'utf8'));
  assert.ok(
    manifest && typeof manifest === 'object' && 'metrics' in manifest && Array.isArray(manifest.metrics),
  );
  for (const metric of ANONYMOUS_METRICS) {
    const declaration: unknown = manifest.metrics.find(
      (entry: unknown) => entry && typeof entry === 'object' && 'name' in entry && entry.name === metric,
    );
    assert.ok(
      declaration &&
        typeof declaration === 'object' &&
        'record' in declaration &&
        declaration.record === 'high',
      metric,
    );
    if ('unit' in declaration)
      assert.ok(
        ['seconds', 'meters', 'bytes', 'ratio', 'points'].includes(String(declaration.unit)),
        'metric units follow the Zirbel wire contract',
      );
    if (metric !== 'round_points')
      assert.ok(!('labels' in declaration), 'extra records carry no identifying labels');
  }
});
