// check() finds what only the game knows is wrong: bad references, overlaps, blocked start slots,
// towns a car can't get round, and it counts what the budgets limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import check from '../src/agent/check.ts';
import { insidePoly } from '../src/town/geometry.ts';
import type { Layout, Spawn } from '../src/town/types.ts';

const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'zirbel.build.json'), 'utf8')) as {
  blocks: { id: string; file: string }[];
};
const shipped = (): Record<string, any> =>
  Object.fromEntries(
    manifest.blocks.map((b) => [b.id, JSON.parse(readFileSync(join(ROOT, b.file), 'utf8'))]),
  );
const messages = (data: Record<string, unknown>): string[] =>
  check(data).problems.map((p) => `${p.block} ${p.path}: ${p.message}`);
// start slots in the middle of the ring road's longest stretches, facing along them (the town has none of its own)
function ringSlots(town: Layout, n: number): Spawn[] {
  return town
    .roads!.filter((r) => r.ring)
    .map((r) => {
      const a = r.line[0]!,
        b = r.line[r.line.length - 1]!;
      return {
        x: (a[0] + b[0]) / 2,
        z: (a[1] + b[1]) / 2,
        yaw: Math.atan2(b[0] - a[0], b[1] - a[1]),
        len: Math.hypot(b[0] - a[0], b[1] - a[1]),
      };
    })
    .sort((p, q) => q.len - p.len)
    .slice(0, n)
    .map(({ x, z, yaw }) => ({ x, z, yaw }));
}

test('start slots on open road are fine', () => {
  const data = shipped(),
    town = data['town'] as Layout;
  town.spawns = ringSlots(town, 4);
  assert.deepEqual(messages(data), []);
});

test('a start slot inside a building is found', () => {
  const data = shipped(),
    town = data['town'] as Layout;
  const b = town.pieces!.find((p) => p.piece.startsWith('building-') && !p.outer)!;
  town.spawns = ringSlots(town, 4);
  town.spawns[1] = { x: b.x, z: b.z, yaw: 0 };
  assert.ok(
    messages(data).some((m) => /^town \/spawns\/1: a car starting here touches a building/.test(m)),
    messages(data).join('\n'),
  );
});

test('a start slot walled in is found', () => {
  const data = shipped(),
    town = data['town'] as Layout;
  town.spawns = ringSlots(town, 4);
  const s = town.spawns[2]!;
  const box: [number, number][] = [
    [s.x - 6, s.z - 6],
    [s.x + 6, s.z - 6],
    [s.x + 6, s.z + 6],
    [s.x - 6, s.z + 6],
    [s.x - 6, s.z - 6],
  ];
  town.walls!.push({ kind: 'wall', line: box });
  assert.ok(
    messages(data).some((m) =>
      /^town \/spawns\/2: a car starting here cannot drive to the ring road/.test(m),
    ),
    messages(data).join('\n'),
  );
});

test('a town cut in two is found', () => {
  const data = shipped(),
    town = data['town'] as Layout,
    B = town.bounds.poly;
  const zs = B.map((p) => p[1]),
    x0 = Math.min(...B.map((p) => p[0])) - 5,
    x1 = Math.max(...B.map((p) => p[0])) + 5,
    z = (Math.min(...zs) + Math.max(...zs)) / 2;
  town.walls!.push({
    kind: 'wall',
    line: [
      [x0, z],
      [x1, z],
    ],
  });
  assert.ok(
    messages(data).some((m) => /only \d+ % of the ring road joins up/.test(m)),
    messages(data).join('\n'),
  );
});

test('buildings on top of each other are found', () => {
  const data = shipped(),
    town = data['town'] as Layout;
  const b = town.pieces!.find((p) => p.piece === 'building-white' && !p.outer)!;
  town.pieces!.push({ ...b, x: b.x + 1 });
  assert.ok(messages(data).some((m) => /overlaps a building-white/.test(m)));
});

test('a piece nobody knows, and one without its size, are found', () => {
  const data = shipped(),
    town = data['town'] as Layout;
  town.pieces!.push({ piece: 'fountain', x: 0, z: 0 }, { piece: 'building-brick', x: 2, z: 2 });
  const m = messages(data);
  assert.ok(m.some((x) => /no piece is called "fountain"/.test(x)));
  assert.ok(m.some((x) => /a building-brick needs w/.test(x)));
});

test('ids used twice and kits that do not exist are found', () => {
  const data = shipped();
  data['kits'].kits.push({ ...data['kits'].kits[1] });
  data['kits'].defaults[0] = 'monster';
  const m = messages(data);
  assert.ok(m.some((x) => /^kits \/kits\/5\/id: the id "rally" is used twice/.test(x)));
  assert.ok(m.some((x) => /^kits \/defaults\/0: no kit is called "monster"/.test(x)));
});

test('a job played with the wrong game is found', () => {
  const data = shipped();
  data['mechanic'].jobs.fuel.game = 'nuts';
  data['mechanic'].jobs.tyre.game = 'pour';
  const m = messages(data);
  assert.ok(
    m.some((x) => /^mechanic \/jobs\/fuel\/game: fuel is poured from a can/.test(x)),
    m.join('\n'),
  );
  assert.ok(
    m.some((x) => /^mechanic \/jobs\/tyre\/game: only fuel is poured/.test(x)),
    m.join('\n'),
  );
});

test('teams that share a paint colour are found', () => {
  const data = shipped();
  data['teams'].teams[3].ui = data['teams'].teams[0].ui;
  assert.ok(messages(data).some((x) => /^teams \/teams\/3\/ui: the same ui colour as team 1/.test(x)));
});

test('a prefab placed in the town counts its pieces and checks them', () => {
  const data = shipped(),
    town = data['town'] as Layout,
    before = check(data).counts['pieces']!;
  // somewhere open on the square: the first spot on a 4 m grid where the jump fits
  const square = town.regions!.find((r) => r.kind === 'square')!,
    xs = square.poly.map((p) => p[0]),
    zs = square.poly.map((p) => p[1]);
  let at: [number, number] | null = null;
  for (let x = Math.min(...xs); x <= Math.max(...xs) && !at; x += 4)
    for (let z = Math.min(...zs); z <= Math.max(...zs) && !at; z += 4) {
      if (!insidePoly(x, z, square.poly)) continue;
      town.prefabs = [{ prefab: 'jump', x, z, yaw: 0 }];
      if (check(data).problems.length === 0) at = [x, z];
    }
  assert.ok(at, 'the jump fits somewhere on the square');
  const { problems, counts } = check(data);
  assert.deepEqual(problems, []);
  assert.equal(counts['pieces'], before + 2);
  town.prefabs = [{ prefab: 'no-such-thing', x: at[0], z: at[1] }];
  assert.ok(messages(data).some((m) => /no prefab is called "no-such-thing"/.test(m)));
  town.prefabs = [{ prefab: 'jump', x: town.pieces![0]!.x, z: town.pieces![0]!.z }];
  assert.ok(
    messages(data).some((m) => /^town \/prefabs: .*overlaps/.test(m)),
    messages(data).join('\n'),
  );
});

test('the shipped data is quick to check', () => {
  const data = shipped();
  check(data);
  // the best of five, so a busy machine's pauses don't count
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    check(data);
    best = Math.min(best, performance.now() - t);
  }
  assert.ok(best < 60, `${best.toFixed(1)} ms: a few milliseconds on a quiet machine; the host allows 20`);
});
