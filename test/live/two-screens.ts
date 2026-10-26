import { skipFirstRunGuide } from './onboarding.ts';
import { BLOCKS } from '../../src/data.ts';
import { launchChrome, type Page } from '@zirbel/engineering/browser';
import { createRequire } from 'node:module';
/**
 * derby01 on two screens through a local zirbel hub that also serves one revision of the data, r1
 * (car hp 80, a 5.5 s countdown, team 1 called Scarlet). Host A and replica B play a round on the
 * built data; B drives; then r1 lands for the room mid-round: that round goes on as it started, the
 * next is played with r1 on both screens. Effects reach the replica; when A leaves, B takes over.
 *
 *   node tools/build.ts --zirbel && node test/live/two-screens.ts
 *
 * Needs a checkout of zirbel.gg next to this one (or ZIRBEL=path) and Chrome. Not run by npm test.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const ZIRBEL = process.env['ZIRBEL'] ?? join(import.meta.dirname, '../../../zirbel.gg');
const ROOT = join(import.meta.dirname, '../..');
const { createHub } = (await import(createRequire(join(ZIRBEL, 'package.json')).resolve('@zirbel/hub'))) as {
  createHub: (o: Record<string, unknown>) => {
    listen(): Promise<void>;
    close(): Promise<void>;
    port: number;
    setRevision(game: string, room: string, rev: { id: string; base: string; engine: boolean }): void;
  };
};

const WORK = mkdtempSync(join(tmpdir(), 'derby-two-'));
const GAME = 'derby01',
  GAMES = join(ROOT, 'dist/zirbel'),
  INSTALLED = join(GAMES, GAME);
// Serve the same vendored public net SDK as the game's browser build.
const NET = join(WORK, 'zirbel-net.js');
await build({
  entryPoints: [join(import.meta.dirname, '../../vendor/zirbel-net/index.ts')],
  outfile: NET,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
// revision r1: three blocks changed
const REV = join(WORK, 'r1');
mkdirSync(join(REV, 'data'), { recursive: true });
const block = (id: string) => JSON.parse(readFileSync(join(ROOT, 'data', `${id}.json`), 'utf8'));
writeFileSync(join(REV, 'data/car.json'), JSON.stringify({ ...block('car'), hp: 80 }));
writeFileSync(join(REV, 'data/rounds.json'), JSON.stringify({ ...block('rounds'), countdown: 5.5 }));
const teams = block('teams');
teams.teams[0].name = 'Scarlet';
writeFileSync(join(REV, 'data/teams.json'), JSON.stringify(teams));

const fileOf = (p: string) => {
  try {
    const s = statSync(p);
    return s.isFile() ? { path: p, size: s.size, mtimeMs: s.mtimeMs, immutable: true } : null;
  } catch {
    return null;
  }
};
const hub = createHub({
  // a page that stalls (software GL on a busy machine) keeps its seat and the host's role meanwhile
  port: Number(process.env['PORT'] ?? 7796),
  host: '127.0.0.1',
  allow: 'any',
  quiet: !process.env['HUB_LOG'],
  grace: 180000,
  hostGrace: 120000,
  games: [{ dir: GAMES, kind: 'local' }],
  net: NET,
  lobby: WORK,
  revisions: {
    async file(game: string, rev: string, path: string) {
      if (game !== GAME || rev !== 'r1') return null;
      const p = path === '' || path.endsWith('/') ? path + 'index.html' : path;
      return (p.startsWith('data/') && fileOf(join(REV, p))) || fileOf(join(INSTALLED, p));
    },
    start: () => null,
    engine: async () => null,
  },
});
await hub.listen();
const ROOM = 'DERBY' + Math.floor(Math.random() * 10000);
const URL_ = `http://127.0.0.1:${hub.port}/${GAME}/@${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}/?room=${ROOM}&debug`;
const flags = [
  ...(process.platform === 'darwin'
    ? ['--use-angle=metal']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--autoplay-policy=no-user-gesture-required',
];
const ca = await launchChrome({
  profile: mkdtempSync(join(tmpdir(), 'derby-a-')),
  headless: true,
  width: 320,
  height: 200,
  args: flags,
});
const cb = await launchChrome({
  profile: mkdtempSync(join(tmpdir(), 'derby-b-')),
  headless: true,
  width: 320,
  height: 200,
  args: flags,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors = (p: Page) =>
  p.console.filter((l) => /^error|exception|TypeError|ReferenceError|derby01:/i.test(l));
const state = async (p: Page) =>
  JSON.parse(
    await p.evaluate<string>(
      `JSON.stringify({ role: document.body.classList.contains('replica') ? 'replica' : 'host', state: derby.G.state, round: derby.G.round, cars: derby.G.cars.length, rev: derby.rev, hp: derby.data.car.hp, maxHp: derby.G.cars[0] && derby.G.cars[0].sys.maxHp, team0: derby.data.teams.teams[0].name, countdown: derby.data.rounds.countdown, fx: derby.net.fx, snaps: derby.net.snaps, humans: derby.G.humans.map(h => h.name + '@' + h.car.idx + '/' + h.seat) })`,
    ),
  );
const t0 = Date.now(),
  at = () => `${Math.round((Date.now() - t0) / 1000)} s`;
let failed = 0;
const check = (what: string, ok: boolean, note = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${note ? ': ' + note : ''}`);
  if (!ok) failed++;
};
try {
  const A = await ca.open('about:blank');
  await A.send('Page.bringToFront');
  await A.send('Page.navigate', { url: URL_ });
  await A.waitFor("window.derby && derby.G.state === 'menu'", 900000);
  await skipFirstRunGuide(A);
  console.log(at(), 'A', JSON.stringify(await state(A)));
  const B = await cb.open('about:blank');
  await B.send('Page.bringToFront');
  await B.send('Page.navigate', { url: URL_ });
  await B.waitFor("window.derby && ['host', 'replica'].includes(derby.net.role)", 900000);
  await skipFirstRunGuide(B);
  console.log(at(), 'B', JSON.stringify(await state(B)));
  await sleep(1500);
  // on a busy machine the first screen can stall long enough for the hub to hand the host's role to
  // the second: so which is which is read, not assumed
  const host0 = (await state(A)).role === 'host' ? A : B;
  if ((await state(host0)).state === 'menu') await host0.click('#startBtn').catch(() => {});
  await A.waitFor(
    "derby.G.state === 'playing' && derby.G.cars.length > 0 && derby.G.humans.length > 0",
    300000,
  );
  await B.waitFor(
    "derby.G.state === 'playing' && derby.G.cars.length > 0 && derby.G.humans.length > 0",
    300000,
  );
  const sa = await state(A),
    sb = await state(B);
  const [H, R, hostChrome] = sa.role === 'host' ? [A, B, ca] : [B, A, cb];
  const h1 = sa.role === 'host' ? sa : sb,
    r1 = sa.role === 'host' ? sb : sa;
  console.log(at(), 'round 1\n  host', JSON.stringify(h1), '\n  replica', JSON.stringify(r1));
  check(
    'one screen hosts, the other draws',
    h1.role === 'host' && r1.role === 'replica',
    `${H === A ? 'A' : 'B'} hosts`,
  );
  check(
    'round 1 is played with the built data on both screens',
    h1.rev === '' && r1.rev === '' && h1.hp === 100 && r1.hp === 100,
  );
  // the replica's driver: W for three seconds of the host's game (with software GL on a busy machine a
  // screen may draw only a frame or two a second, so the time is the game's, not the wall clock's)
  const mine = Number(String(r1.humans[0]).split('@')[1]?.split('/')[0] ?? 1);
  // nobody chooses a name: the hub names the screens' seats, and both screens show each player the same
  const nameOf = (s: { humans: string[] }) => String(s.humans[0]).split('@')[0];
  const crewOf = (p: Page, car: number) =>
    p.evaluate<string>(
      `JSON.stringify(derby.G.cars[${car}].occ.filter(o => o && o.kind === 'human').map(o => [o.h.name, o.h.tag]))`,
    );
  const carOf = (s: { humans: string[] }) => Number(String(s.humans[0]).split('@')[1]?.split('/')[0] ?? 0);
  check(
    'the hub names the two screens Player One and Player Two',
    [nameOf(h1), nameOf(r1)].sort().join() === 'Player One,Player Two',
    `${nameOf(h1)} hosts, ${nameOf(r1)} draws`,
  );
  const tag = (n: string | undefined) => {
    if (n === undefined) throw new Error('Hub participant has no name');
    return n.replace(/^Player One$/, 'P1').replace(/^Player Two$/, 'P2');
  };
  const seenOnHost = await crewOf(H, carOf(r1)),
    seenOnReplica = await crewOf(R, carOf(h1));
  check(
    "each screen shows the other player by the hub's name, and the tag over the car short",
    seenOnHost.includes(JSON.stringify([nameOf(r1), tag(nameOf(r1))])) &&
      seenOnReplica.includes(JSON.stringify([nameOf(h1), tag(nameOf(h1))])),
    `host sees ${seenOnHost}, replica sees ${seenOnReplica}`,
  );
  const where = () => H.evaluate<number[]>(`[derby.G.cars[${mine}].pos.x, derby.G.cars[${mine}].pos.z]`);
  const gameTime = () => H.evaluate<number>('derby.G.time');
  await R.send('Page.bringToFront');
  await R.waitFor('document.hasFocus() && !document.hidden && !derby.G.menuOpen', 30000);
  const p0 = await where();
  await R.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    code: 'KeyW',
    key: 'w',
    windowsVirtualKeyCode: 87,
  });
  await R.waitFor("derby.Input.keys.has('KeyW')", 30000);
  // Focus and protocol acknowledgements can take time; measure the actual held-input interval.
  const s0 = (await state(R)).snaps,
    g0 = await gameTime(),
    w0 = Date.now();
  while ((await gameTime()) - g0 < 3 && Date.now() - w0 < 180000) await sleep(500);
  await R.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    code: 'KeyW',
    key: 'w',
    windowsVirtualKeyCode: 87,
  });
  const p1 = await where(),
    s1 = (await state(R)).snaps,
    g1 = await gameTime();
  console.log(`  (3 s of the host's game took ${((Date.now() - w0) / 1000).toFixed(0)} s here)`);
  check(
    'the replica drives its car on the host',
    Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!) > 3,
    `${Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!).toFixed(1)} m`,
  );
  check(
    'snapshots keep coming',
    (s1 - s0) / Math.max(0.1, g1 - g0) > 10,
    `${s1 - s0} in ${(g1 - g0).toFixed(1)} s of the game`,
  );
  // a revision lands mid-round
  hub.setRevision(GAME, ROOM, { id: 'r1', base: `/${GAME}/@r1/`, engine: false });
  await sleep(4000);
  const h2 = await state(H),
    r2 = await state(R);
  check(
    'the round in play goes on with the data it started with',
    h2.round === h1.round && h2.rev === '' && h2.hp === 100 && r2.rev === '',
  );
  check('effects reach the replica', r2.fx > 0, `${r2.fx} batches`);
  // Readiness is observed: a loaded host may take longer than a fixed sleep to fetch every block.
  const revisionReady = `new Set(performance.getEntriesByType('resource').filter(entry => entry.name.includes('/@r1/data/')).map(entry => entry.name.split('?')[0])).size === ${BLOCKS.length}`;
  await Promise.all([H.waitFor(revisionReady, 180000), R.waitFor(revisionReady, 180000)]);
  // the next round
  await H.evaluate('derby.startRound()');
  await R.waitFor(`derby.G.round > ${h1.round} && ['countdown', 'playing'].includes(derby.G.state)`, 120000);
  await sleep(1000);
  const h3 = await state(H),
    r3 = await state(R);
  console.log(at(), 'round 2\n  host', JSON.stringify(h3), '\n  replica', JSON.stringify(r3));
  check(
    'the host plays round 2 with r1',
    h3.rev === 'r1' && h3.hp === 80 && h3.maxHp === 80 && h3.countdown === 5.5 && h3.team0 === 'Scarlet',
  );
  check(
    'the replica built round 2 with r1',
    r3.rev === 'r1' && r3.hp === 80 && r3.countdown === 5.5 && r3.team0 === 'Scarlet',
  );
  check(
    "the replica's screen says Scarlet",
    await R.waitFor('/scarlet/i.test(document.body.innerText)', 60000).then(
      () => true,
      () => false,
    ),
  );
  // the host leaves: the other screen takes over, and goes on with r1
  const hostErrors = errors(H);
  await hostChrome.close();
  await R.waitFor(
    "!document.body.classList.contains('replica') && ['countdown','playing'].includes(derby.G.state)",
    120000,
  ).catch((e) => console.log('takeover:', String(e)));
  await sleep(2000);
  const r4 = await state(R);
  console.log(at(), 'after the takeover', JSON.stringify(r4));
  check('the other screen takes over and goes on with r1', r4.role === 'host' && r4.rev === 'r1');
  check('no errors on the host', hostErrors.length === 0, hostErrors.slice(0, 4).join(' | '));
  check('no errors on the replica', errors(R).length === 0, errors(R).slice(0, 4).join(' | '));
} finally {
  await ca.close().catch(() => {});
  await cb.close().catch(() => {});
  await hub.close().catch(() => {});
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
