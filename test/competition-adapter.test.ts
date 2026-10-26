/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptCompetitionSummary,
  anonymousRecords,
  beginCompetition,
  currentCompetitionSummary,
  finishCompetition,
  recordCompetitionHit,
  recordCompetitionShot,
  recordCompetitionRepair,
  resetCompetition,
  subscribeCompetition,
  updateCompetition,
} from '../src/competition.ts';
import { G } from '../src/state.ts';
import { currentRole, setRole } from '../src/net/role.ts';
import { getSession, setSession, type Session } from '../src/net/context.ts';
import type { Car } from '../src/car-types.ts';

test('competition adapter preserves shot identity, emits anonymous host metrics once and retains last round', () => {
  const original = {
    round: G.round,
    state: G.state,
    cars: G.cars,
    points: G.points,
    time: G.time,
    winnerTeam: G.winnerTeam,
  };
  const role = currentRole();
  const session = getSession();
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let saved = '';
  const storage: Storage = {
    length: 0,
    key: () => null,
    clear() {},
    removeItem() {},
    getItem: () => null,
    setItem: (_key, value) => {
      saved = value;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const emitted: unknown[][] = [];
  setSession({
    net: {
      isHost: () => true,
      metric: (...args: unknown[]) => {
        emitted.push(args);
      },
    },
  } as unknown as Session);
  setRole('host');
  const makeCar = (team: number): Car =>
    ({
      idx: team,
      team,
      cfg: { kit: 'rally' },
      alive: true,
      vel: { x: 0, z: 10 },
      occ: [
        { kind: 'human', h: { remote: false, id: team, name: `Private ${team}`, tag: `P${team}` } },
        null,
        null,
        null,
      ],
    }) as unknown as Car;
  const car = makeCar(0);
  Object.assign(G, {
    round: 1,
    state: 'countdown',
    cars: [car, makeCar(1)],
    points: [0, 0],
    time: 0,
    winnerTeam: 0,
  });
  resetCompetition();
  let notifications = 0;
  const unsubscribe = subscribeCompetition(() => {
    notifications++;
  });
  try {
    beginCompetition();
    G.state = 'playing';
    recordCompetitionRepair(car, 20);
    const projectile = {};
    recordCompetitionShot(car, 0, projectile);
    car.occ[0] = null;
    recordCompetitionHit(projectile);
    recordCompetitionHit(projectile);
    updateCompetition(0.5);
    G.state = 'over';
    G.time = 5;
    G.points = [50, 0];
    const summary = finishCompetition();
    assert.ok(summary);
    assert.equal(
      summary.players.find((player) => player.name === 'Private 0')?.hits,
      1,
      'changing seat never transfers a projectile hit',
    );
    assert.equal(summary.teams[0]?.distanceM, 5);
    assert.ok(emitted.length > 0);
    assert.ok(
      emitted.every(
        (args) => args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'number',
      ),
    );
    assert.ok(!saved.includes('Private') && !saved.includes('local:') && !saved.includes('round":'));
    const count = emitted.length;
    assert.equal(finishCompetition(), summary);
    assert.equal(emitted.length, count);
    G.round = 2;
    G.state = 'countdown';
    beginCompetition();
    assert.equal(currentCompetitionSummary(), summary, 'the completed report survives the next round');
    setRole('replica');
    G.state = 'playing';
    recordCompetitionShot(car, 0, {});
    acceptCompetitionSummary({ ...summary, round: 99 });
    assert.equal(currentCompetitionSummary(), summary, 'future reports are rejected');
    const received = {
      ...summary,
      round: 2,
      mechanics: summary.mechanics.map((standing) => ({
        ...standing,
        totalPoints: standing.team === 0 ? 100 : 0,
      })),
      constructors: summary.constructors.map((standing) => ({
        ...standing,
        rounds: 2,
        points: standing.points + 42,
      })),
    };
    acceptCompetitionSummary(JSON.parse(JSON.stringify(received)));
    assert.deepEqual(currentCompetitionSummary(), received);
    assert.equal(emitted.length, count, 'replicas never emit metric records');
    // The same screen may regain authority: its old private tracker must not override received standings.
    setRole('host');
    G.round = 3;
    G.state = 'countdown';
    beginCompetition();
    G.state = 'playing';
    recordCompetitionRepair(car, 20);
    G.state = 'over';
    const migrated = finishCompetition();
    assert.ok(migrated);
    assert.equal(migrated.mechanics[0]?.totalPoints, 112);
    assert.equal(migrated.constructors[0]?.rounds, 3);
    const board = anonymousRecords();
    board.round_points.length = 0;
    assert.deepEqual(anonymousRecords().round_points, [50, 0], 'callers cannot mutate saved records');
    resetCompetition();
    assert.equal(currentCompetitionSummary(), null);
    assert.ok(notifications >= 4);
    unsubscribe();
    const before = notifications;
    resetCompetition();
    assert.equal(notifications, before);
  } finally {
    unsubscribe();
    resetCompetition();
    Object.assign(G, original);
    setSession(session);
    setRole(role);
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
