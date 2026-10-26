import { skipFirstRunGuide } from './onboarding.ts';
import { connect } from '../../vendor/zirbel-net/index.ts';
import { launchChrome } from '@zirbel/engineering/browser';
import { createRequire } from 'node:module';
/**
 * The play adapter against a real host: a local zirbel hub serving dist/zirbel, the game's page in
 * headless Chrome as the room's host (map 8411, started at once), and the adapter in this process as
 * an ordinary seat over zirbel-net. It drives, steers toward a car, changes seat, aims and fires,
 * clears a jam, and does two mechanic jobs, checking each on the host's own game state. It also
 * records what the host sent, for test/play.test.ts.
 *
 *   node tools/build.ts --zirbel && node test/live/play-live.ts [--record test/fixtures/messages.json]
 *
 * Needs a checkout of zirbel.gg next to this one (or ZIRBEL=path) and Chrome. Not run by npm test.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adapter from '../../src/agent/play.ts';

const ZIRBEL = process.env['ZIRBEL'] ?? join(import.meta.dirname, '../../../zirbel.gg');

const PORT = Number(process.env['PORT'] ?? 7811);
const ROOM = 'AGENTS' + Math.floor(Math.random() * 10000);
const RECORD = process.argv.includes('--record') ? process.argv[process.argv.indexOf('--record') + 1]! : '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, note = ''): void => {
  results.push([name, ok, note]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ': ' + note : ''}`);
};

// Match the shipped game's vendored SDK and keep the fixture independent of a built hub shell.
const work = mkdtempSync(join(tmpdir(), 'zplaynet-'));
writeFileSync(join(work, 'index.html'), '<!doctype html><title>Derby live fixture</title>');
const netFile = join(work, 'zirbel-net.js');
await (
  await import('esbuild')
).build({
  entryPoints: [join(import.meta.dirname, '../../vendor/zirbel-net/index.ts')],
  outfile: netFile,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
const hub = spawn(
  process.execPath,
  [
    createRequire(join(ZIRBEL, 'package.json')).resolve('@zirbel/hub/cli'),
    '--games',
    join(import.meta.dirname, '../../dist/zirbel'),
    '--port',
    String(PORT),
    '--allow',
    'any',
    '--host',
    '127.0.0.1',
    '--net',
    netFile,
    '--lobby',
    work,
    '--host-grace',
    '120000',
    '--grace',
    '180000',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
await new Promise<void>((ok, fail) => {
  const t = setTimeout(() => fail(new Error('the hub did not start')), 30000);
  const look = (d: Buffer) => {
    if (/listening on/.test(String(d))) {
      clearTimeout(t);
      ok();
    }
  };
  hub.stdout.on('data', look);
  hub.stderr.on('data', look);
});
const chrome = await launchChrome({
  profile: mkdtempSync(join(tmpdir(), 'zplay-')),
  headless: true,
  width: 320,
  height: 200,
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--autoplay-policy=no-user-gesture-required',
  ],
});
let session: ReturnType<typeof adapter.start> | null = null,
  net: ReturnType<typeof connect> | null = null;
const log: { t: number; from: number; type: number; reliable: boolean; b64: string }[] = [];
try {
  const A = await chrome.open('about:blank');
  await A.send('Page.bringToFront');
  await A.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/derby01/@0.1.0/index.html?room=${ROOM}&map=8411&autostart=1&debug`,
  });
  await A.waitFor(
    "window.derby && derby.net.role === 'host' && ['countdown','playing'].includes(derby.G.state)",
    600000,
  );
  await skipFirstRunGuide(A);
  console.log(
    'host page is running round',
    await A.evaluate('derby.G.round'),
    'on map',
    await A.evaluate('derby.setup.mapSeed'),
  );
  // a hidden host keeps the round going from a worker's clock without drawing: on a busy machine that keeps it real time
  const B = await chrome.open('about:blank');
  await B.send('Page.bringToFront');

  // the agent: an ordinary seat in the room
  net = connect({ url: `ws://127.0.0.1:${PORT}/mp`, game: 'derby01', room: ROOM, storage: null });
  const t0 = performance.now();
  let snaps = 0,
    fxBatches = 0;
  net.on('message', (from, type, r, reliable) => {
    if (type === 7) fxBatches++;
    if (!RECORD) return;
    if (type === 8 && snaps++ % 4 !== 0) return; // every fourth snapshot is plenty
    if (log.length < 1500)
      log.push({
        t: Math.round(performance.now() - t0),
        from,
        type,
        reliable,
        b64: Buffer.from(r.rest()).toString('base64'),
      });
  });
  session = adapter.start(net as never, { name: 'live test' });
  let towns = 0;
  let town: any = null;
  const obs = () => {
    const o = session!.observe() as any;
    if (o.town) {
      towns++;
      town = o.town;
    }
    return o;
  };
  const until = async (what: string, test: () => boolean, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(250);
    }
    console.log('  waited for', what, '| state', JSON.stringify(obs()).slice(0, 300));
    return false;
  };
  check(
    'the agent gets a seat in the running round',
    await until('a seat', () => !!obs().you && ['countdown', 'playing'].includes(obs().state), 60000),
    JSON.stringify(obs().you),
  );
  const me = obs().you.car as number;
  check("it joined as a driver (the host gives newcomers a bot's driving seat)", obs().you.seat === 'driver');
  await until('playing', () => obs().state === 'playing', 30000);
  const o1 = obs();
  check(
    'it sees every car',
    o1.cars.length >= 2 && o1.cars.every((c: any) => typeof c.x === 'number'),
    `${o1.cars.length} cars`,
  );
  check(
    'it knows the town (feelers in eight directions)',
    !!o1.driver?.around && Object.keys(o1.driver.around).length === 8,
    JSON.stringify(o1.driver?.around),
  );
  obs();
  check('the town comes once', towns === 1, `${towns} times`);
  check("it sees its car's systems", typeof o1.car?.fuel === 'number', JSON.stringify(o1.car));

  // driving: full throttle for three seconds of the host's game moves the car there (with software GL
  // on a busy machine the host may draw only a frame or two a second: the time is the game's)
  const pos = () => A.evaluate<number[]>(`[derby.G.cars[${me}].pos.x, derby.G.cars[${me}].pos.z]`);
  const gameTime = () => A.evaluate<number>('derby.G.time');
  const gameWait = async (s: number) => {
    const g = await gameTime();
    while ((await gameTime()) - g < s) await sleep(250);
  };
  // The network driving assertion needs an open straight, independent of shuffled spawn headings.
  // Choose an existing direct navigation edge on the real map, away from the other cars.
  await A.evaluate(`(() => {
    const car = derby.G.cars[${me}], nav = derby.nav;
    const candidates = [];
    for (let i = 0; i < nav.nodes.length; i++) for (let j = 0; j < nav.nodes.length; j++) {
      if (i === j || nav.next[i][j] !== j || nav.D[i][j] < 25) continue;
      const [x, z] = nav.nodes[i], [tx, tz] = nav.nodes[j];
      const clearance = Math.min(...derby.G.cars.filter(c => c !== car).map(c => Math.hypot(c.pos.x - x, c.pos.z - z)));
      candidates.push({ x, z, tx, tz, clearance });
    }
    candidates.sort((a, b) => b.clearance - a.clearance);
    const route = candidates[0];
    if (!route || route.clearance < 10) throw new Error('No isolated navigation edge for driving fixture');
    car.pos.set(route.x, 0, route.z);
    car.vel.set(0, 0, 0);
    car.yaw = Math.atan2(route.tx - route.x, route.tz - route.z);
  })()`);
  const p0 = await pos();
  check(
    'act accepts driving',
    (session.act({ throttle: 1, steer: 0 }) as any).ok,
    'along an open navigation edge',
  );
  await gameWait(3);
  const p1 = await pos();
  check(
    "the host's car moved",
    Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!) > 3,
    `${Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!).toFixed(1)} m`,
  );
  const wrong = session.act({ aim: { car: 0 } }) as any;
  check("a driver can't aim", !wrong.ok && /gunner/.test(wrong.error), wrong.error);
  // toward a point on a street a little way off: the car gets near it (a point stays put, a car doesn't).
  // First back off whatever the straight run ended against.
  session.act({ throttle: -1 });
  const gb = await gameTime();
  while ((await gameTime()) - gb < 1.5) await sleep(250);
  const here = await pos();
  const mids = ((town?.streets ?? []) as { line: number[][] }[])
    .map((st) => {
      const a = st.line[0]!,
        b = st.line[st.line.length - 1]!;
      return { x: (a[0]! + b[0]!) / 2, z: (a[1]! + b[1]!) / 2 };
    })
    .map((m) => ({ ...m, d: Math.hypot(m.x - here[0]!, m.z - here[1]!) }))
    .filter((m) => m.d > 15 && m.d < 60)
    .sort((a, b) => b.d - a.d);
  const goal = mids[0] ?? { x: 0, z: 0, d: Math.hypot(here[0]!, here[1]!) };
  session.act({ throttle: 0.7, toward: { x: goal.x, z: goal.z } });
  const gt = await gameTime();
  let closest = goal.d;
  // (sampled at least once: with a hidden host on a busy machine the six seconds may pass before the first look)
  do {
    const q = await pos();
    closest = Math.min(closest, Math.hypot(q[0]! - goal.x, q[1]! - goal.z));
    await sleep(300);
  } while ((await gameTime()) - gt < 6);
  check(
    'toward steers at a point',
    closest < goal.d - 5 || closest < 6,
    `${goal.d.toFixed(0)} m away, ${closest.toFixed(0)} m at the closest`,
  );
  session.act({});

  // the hood gun
  check('it asks to change seat', (session.act({ seat: 'hood' }) as any).ok);
  check('it sits at the hood gun', await until('hood', () => obs().you?.seat === 'hood', 10000));
  const hp0 = await A.evaluate<number[]>('derby.G.cars.map((c) => c.hp)'),
    gun0 = await A.evaluate<number>('derby.G.stats.gun || 0');
  const tg =
    (obs().gun?.targets as any[] | undefined)?.find((t) => t.inArc) ??
    (obs().gun?.targets as any[] | undefined)?.[0];
  check('it sees targets from its gun', !!tg, JSON.stringify(obs().gun));
  session.act({ aim: { car: tg.car }, fire: true });
  await gameWait(4);
  const gunDamage = (await A.evaluate<number>('derby.G.stats.gun || 0')) - gun0;
  const ev = session.events() as any[];
  const hp1 = await A.evaluate<number[]>('derby.G.cars.map((c) => c.hp)');
  check(
    'the hood gun fired on the host, and its paint did damage',
    gunDamage > 0,
    `${gunDamage.toFixed(1)} damage by paint`,
  );
  check(
    'the paint landed',
    ev.some((e) => e.type === 'hit') || hp1[tg.car]! < hp0[tg.car]!,
    `target hp ${hp0[tg.car]} -> ${hp1[tg.car]}, ${ev.filter((e) => e.type === 'hit').length} hits`,
  );
  session.act({ aim: { car: tg.car } });
  // a jam: cleared after its time, and not before
  await A.evaluate(`(() => { const g = derby.G.cars[${me}].gun[1]; g.jam = true; g.firing = false; })()`);
  await until('jam seen', () => obs().gun?.jam === true, 5000);
  check('a jam is cleared with unjam', (session.act({ unjam: true }) as any).ok);
  await sleep(700);
  check('not at once', await A.evaluate<boolean>(`derby.G.cars[${me}].gun[1].jam`));
  await sleep(1500);
  check(
    'but after about a second and a half',
    !(await A.evaluate<boolean>(`derby.G.cars[${me}].gun[1].jam`)),
  );

  // the mechanic
  session.act({ seat: 'mechanic' });
  check(
    "it sits in the mechanic's seat",
    await until('mechanic', () => obs().you?.seat === 'mechanic', 10000),
  );
  await A.evaluate(`derby.breakTire(derby.G.cars[${me}], 0)`);
  check(
    'a flat tyre shows as a job',
    await until('job', () => (obs().jobs as any[] | undefined)?.some((j) => j.id === 'tire0') ?? false, 5000),
    JSON.stringify(obs().jobs),
  );
  const started = performance.now();
  check('it starts the job', (session.act({ job: 'tire0' }) as any).ok);
  await until('fixed', () => !((obs().jobs as any[] | undefined) ?? []).some((j) => j.id === 'tire0'), 10000);
  const took = (performance.now() - started) / 1000;
  const tyre = await A.evaluate<number[]>(
    `[derby.G.cars[${me}].sys.tires[0], derby.G.cars[${me}].stock.tyres]`,
  );
  check(
    'the host fitted the spare',
    tyre[0] === 1 && tyre[1] === 0,
    `tyre ${tyre[0]}, spares left ${tyre[1]}`,
  );
  check('as slowly as a skilled person', took >= 2.4, `${took.toFixed(1)} s`);
  // Isolate the can transaction from an autonomous driver's pickups and fuel use.
  await A.evaluate(`(() => {
    const car = derby.G.cars[${me}];
    car.occ[0] = null;
    Object.assign(car.ctrl, {throttle: 0, steer: 0, handbrake: true, boost: false});
    car.vel.set(0, 0, 0);
    car.sys.fuel = 40;
    car.sys.leak = false;
    car.stock.fuel = 1;
  })()`);
  await until('fuel job', () => ((obs().jobs as any[] | undefined) ?? []).some((j) => j.id === 'fuel'), 5000);
  session.act({ job: 'fuel' });
  await until('fuel can settled', () => obs().car?.spares?.fuel === 0, 15000);
  const fuel = await A.evaluate<number[]>(`[derby.G.cars[${me}].sys.fuel, derby.G.cars[${me}].stock.fuel]`);
  check(
    'it poured a can into the tank',
    fuel[0]! > 85 && fuel[1] === 0,
    `fuel ${fuel[0]!.toFixed(0)} %, cans left ${fuel[1]}`,
  );
  const all = session.events() as any[];
  check(
    'events tell what happened',
    all.some((e) => e.type === 'job' && e.done) && all.some((e) => e.type === 'seat'),
    [...new Set(all.map((e) => e.type))].join(', '),
  );
  console.log("a view from the mechanic's seat:", JSON.stringify(obs()).slice(0, 900));
  check('the host sends its effect batches', fxBatches > 0, `${fxBatches} batches`);
  const errors = A.console.filter((l) => /^error|TypeError|ReferenceError/i.test(l));
  check('the host page had no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  session?.stop();
  net?.close();
  if (RECORD) {
    writeFileSync(RECORD, JSON.stringify({ room: ROOM, seat: net?.id ?? 0, messages: log }));
    console.log('recorded', log.length, 'messages to', RECORD);
  }
  await chrome.close().catch(() => {});
  hub.kill();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
