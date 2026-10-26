/** Actual WebGL damage, replica detail and fresh-round takeover. Build with npm run zirbel first. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { launchChrome, type Chrome, type Page } from '@zirbel/engineering/browser';
import { skipFirstRunGuide } from './onboarding.ts';
import { BODY_PANELS, type BodyworkState } from '../../src/gameplay/body-damage.ts';
import type { Direction } from '../../src/gameplay/input.ts';

const ROOT = join(import.meta.dirname, '../..');
const ZIRBEL = process.env['ZIRBEL'] ?? join(ROOT, '../zirbel.gg');
const WORK = mkdtempSync(join(tmpdir(), 'derby-body-'));
const OUTPUT = process.env['ARTIFACT_DIR'] ?? WORK;
mkdirSync(OUTPUT, { recursive: true });
const { createHub } = (await import(createRequire(join(ZIRBEL, 'package.json')).resolve('@zirbel/hub'))) as {
  createHub(options: Record<string, unknown>): {
    listen(): Promise<void>;
    close(): Promise<void>;
    port: number;
  };
};
const net = join(WORK, 'zirbel-net.js');
await build({
  entryPoints: [join(ROOT, 'vendor/zirbel-net/index.ts')],
  outfile: net,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
const hub = createHub({
  port: Number(process.env['PORT'] ?? 7797),
  host: '127.0.0.1',
  allow: 'any',
  quiet: true,
  grace: 30000,
  hostGrace: 15000,
  games: [{ dir: join(ROOT, 'dist/zirbel'), kind: 'local' }],
  net,
  lobby: WORK,
});
const flags = [
  ...(process.platform === 'darwin'
    ? ['--use-angle=metal']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--autoplay-policy=no-user-gesture-required',
];
const browsers: Chrome[] = [];
const wait = (page: Page, expression: string) => page.waitFor(expression, 120000);
const freeze = (page: Page) =>
  page.evaluate(`(() => {
    for (const c of derby.G.cars) {
      for (const occupant of c.occ) if (occupant && occupant.kind === 'bot') delete occupant.bot;
      c.ctrl.throttle = 0; c.ctrl.steer = 0; c.ctrl.handbrake = true; c.ctrl.boost = false;
      c.vel.set(0, 0, 0);
    }
  })()`);

async function press(page: Page, code: string, key: string, number: number, observed: string): Promise<void> {
  await page.send('Page.bringToFront');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: number });
  try {
    await wait(page, observed);
  } finally {
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: number });
  }
}

async function picture(page: Page, car: number, path: string): Promise<void> {
  await wait(page, 'derby.G.goT <= 0');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The debug camera is intentionally spectator-only. Temporarily borrow that view without changing seats.
  await page.evaluate(`(() => {
    const c = derby.G.cars[${car}], T = derby.THREE;
    const position = new T.Vector3(4.5, 2.7, 4.2).applyAxisAngle(new T.Vector3(0, 1, 0), c.yaw).add(c.pos);
    const look = c.pos.clone().add(new T.Vector3(0, 0.8, 0.3));
    const riders = [];
    for (const rider of c.riders) if (rider) rider.traverse(object => {
      riders.push([object, object.layers.mask]); object.layers.enable(0);
    });
    window.bodyProof = { humans: derby.G.humans, camera: derby.debugCam, riders };
    derby.G.humans = [];
    derby.debugCam = { pos: position.toArray(), look: look.toArray() };
    document.querySelectorAll('.vp, #topbar').forEach(el => el.style.visibility = 'hidden');
  })()`);
  try {
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await page.screenshot(path);
  } finally {
    await page.evaluate(`(() => {
      derby.G.humans = window.bodyProof.humans;
      for (const [object, mask] of window.bodyProof.riders) object.layers.mask = mask;
      if (window.bodyProof.camera) derby.debugCam = window.bodyProof.camera; else delete derby.debugCam;
      delete window.bodyProof;
      document.querySelectorAll('.vp, #topbar').forEach(el => el.style.removeProperty('visibility'));
    })()`);
  }
}

const inventory = (car: number) => `(() => {
  const c = derby.G.cars[${car}], interior = c.body.getObjectByName('car-interior');
  return { alive: c.alive, panels: Object.keys(c.parts).sort(),
    attached: c.wheels.map(w => w.attached), wheelOff: c.sys.wheelOff, bodywork: c.bodywork,
    interior: !!interior && interior.parent === c.body && interior.children.length === 3,
    triangles: interior ? interior.children.reduce((n,m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0) : 0,
    anchored: c.turrets.hood.base.parent === c.body };
})()`;
interface Inventory {
  alive: boolean;
  panels: string[];
  attached: boolean[];
  wheelOff: boolean[];
  bodywork: BodyworkState;
  interior: boolean;
  triangles: number;
  anchored: boolean;
}

/** Local mesh transforms exclude suspension/chassis motion from the visual assertion. */
async function panelMotion(page: Page, car: number): Promise<number[][]> {
  return page.evaluate<number[][]>(`(() => {
    const c = derby.G.cars[${car}];
    return ['L_Door_Front', 'car_hood'].map(name => {
      const panel = c.parts[name]; panel.updateMatrix(); return panel.matrix.toArray();
    });
  })()`);
}

async function assertPanelMotion(page: Page, car: number, label: string): Promise<void> {
  const first = await panelMotion(page, car);
  const time = await page.evaluate<number>('derby.G.time');
  await wait(page, `derby.G.time >= ${time + 0.25}`);
  const second = await panelMotion(page, car);
  for (const [index, name] of ['door', 'hood'].entries()) {
    const start = first[index],
      end = second[index];
    assert(start && end);
    assert(
      end.some((value, component) => Math.abs(value - (start[component] ?? value)) > 0.0001),
      `${label} loose ${name} visibly moves`,
    );
  }
}

const MECHANIC = 'derby.G.humans[0].mech';
const directionKeys: Record<Direction, readonly [string, string, number]> = {
  up: ['KeyW', 'w', 87],
  down: ['KeyS', 's', 83],
  left: ['KeyA', 'a', 65],
  right: ['KeyD', 'd', 68],
};

async function startPanelJob(page: Page, name: string): Promise<void> {
  await wait(
    page,
    `${MECHANIC}?.tasks?.some(task => task.kind === 'panel' && task.name === ${JSON.stringify(name)})`,
  );
  for (let attempts = 0; attempts < 40; attempts++) {
    const selection = await page.evaluate<{ wanted: number; selected: number; ids: string[] }>(`(() => {
      const m = ${MECHANIC}; return { wanted: m.tasks.findIndex(task => task.kind === 'panel' && task.name === ${JSON.stringify(name)}),
        selected: m.tasks.findIndex(task => task.id === m.sel), ids: m.tasks.map(task => task.id) };
    })()`);
    assert(selection.wanted >= 0);
    if (selection.selected === selection.wanted) {
      await press(page, 'Space', ' ', 32, `${MECHANIC}.game?.task.name === ${JSON.stringify(name)}`);
      assert.equal(await page.evaluate(`${MECHANIC}.game.type`), 'nuts');
      return;
    }
    const down = selection.selected < selection.wanted;
    const next = selection.ids[Math.max(0, selection.selected) + (down ? 1 : -1)];
    assert(next);
    await press(
      page,
      down ? 'KeyS' : 'KeyW',
      down ? 's' : 'w',
      down ? 83 : 87,
      `${MECHANIC}.sel === ${JSON.stringify(next)}`,
    );
  }
  assert.fail(`Could not select ${name} tightening job`);
}

async function finishPanelJob(page: Page, beforeFinalTap?: () => Promise<void>): Promise<void> {
  const sequence = await page.evaluate<Direction[]>(`${MECHANIC}.game.seq`);
  for (const [index, direction] of sequence.entries()) {
    const [code, key, number] = directionKeys[direction];
    await press(page, code, key, number, `${MECHANIC}.game.i === ${index + 1}`);
  }
  const taps = await page.evaluate<number>(`${MECHANIC}.game.taps`);
  for (let tap = 1; tap <= taps; tap++) {
    if (tap === taps && beforeFinalTap) {
      await wait(page, `${MECHANIC}.game.elapsed >= ${MECHANIC}.game.minTime`);
      await beforeFinalTap();
    }
    await press(page, 'Space', ' ', 32, `!${MECHANIC}.game || ${MECHANIC}.game.mash >= ${tap}`);
  }
  await wait(page, `!${MECHANIC}.game`);
}

async function mechanicRepairs(host: Page, replica: Page): Promise<void> {
  const car = await replica.evaluate<number>('derby.G.humans[0].car.idx');
  const crew = await host.evaluate<string>(`derby.data.teams.teams[derby.G.cars[${car}].team].name`);
  for (
    let switches = 0;
    switches < 4 && (await replica.evaluate<number>('derby.G.humans[0].seat')) !== 3;
    switches++
  ) {
    const seat = await replica.evaluate<number>('derby.G.humans[0].seat');
    await press(replica, 'KeyC', 'c', 67, `derby.G.humans[0].seat !== ${seat}`);
    await freeze(host);
    // Seat commands have a real 400 ms host cooldown; a simulated half-second respects it under load too.
    const time = await host.evaluate<number>('derby.G.time');
    await wait(host, `derby.G.time >= ${time + 0.5}`);
  }
  assert.equal(await replica.evaluate('derby.G.humans[0].seat'), 3);
  const closed = await panelMotion(host, car);
  await host.evaluate(`(() => {
    const c = derby.G.cars[${car}];
    derby.hitCar(c,20,null,'lf','crash',{x:.95,y:.5,z:.5},8);
    derby.hitCar(c,20,null,'front','crash',{x:0,y:.5,z:2},8);
    derby.hitCar(c,20,null,'rear','crash',{x:0,y:.5,z:-2},8);
  })()`);
  for (const name of ['L_Door_Front', 'car_hood']) {
    await startPanelJob(replica, name);
    if (name === 'L_Door_Front') {
      await replica.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await replica.evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      await replica.screenshot(join(OUTPUT, 'derby-body-tighten-minigame.png'));
    }
    if (name === 'L_Door_Front') {
      await finishPanelJob(replica, async () => {
        await host.evaluate(`(() => {
          const mechanic = derby.G.remotes.find(human => human.car.idx === ${car} && human.seat === 3);
          if (!mechanic) throw new Error('Missing authoritative remote mechanic');
          mechanic.fixAt = performance.now();
        })()`);
      });
      await wait(replica, `!!${MECHANIC}.pending`);
      assert.notEqual(
        await replica.evaluate(`${MECHANIC}.msg`),
        'FIXED!',
        'client does not announce a rejected repair as fixed',
      );
      assert.notEqual(
        (await host.evaluate<Inventory>(inventory(car))).bodywork.L_Door_Front.looseSince,
        null,
        'first completion remains rejected by host cooldown',
      );
      await replica.screenshot(join(OUTPUT, 'derby-body-tighten-waiting.png'));
      await wait(replica, `!${MECHANIC}.pending && ${MECHANIC}.msg === 'FIXED!'`);
    } else await finishPanelJob(replica);
    await wait(host, `derby.G.cars[${car}].bodywork[${JSON.stringify(name)}].looseSince === null`);
    await wait(replica, `derby.G.cars[${car}].bodywork[${JSON.stringify(name)}].looseSince === null`);
    const repaired = await host.evaluate<Inventory>(inventory(car));
    assert.equal(repaired.bodywork[name === 'car_hood' ? 'car_hood' : 'L_Door_Front'].wear, 0);
    assert(repaired.panels.includes(name));
  }
  const time = await host.evaluate<number>('derby.G.time');
  await wait(host, `derby.G.time >= ${time + 2}`);
  const settled = await panelMotion(host, car);
  const replicaSettled = await panelMotion(replica, car);
  for (const [index, rest] of closed.entries()) {
    assert(
      settled[index]?.every((value, component) => Math.abs(value - (rest[component] ?? value)) < 0.0001),
      'repaired panel closes to original pose',
    );
    assert(
      replicaSettled[index]?.every(
        (value, component) => Math.abs(value - (rest[component] ?? value)) < 0.0001,
      ),
      'replica repaired panel closes',
    );
  }
  const settledTime = await host.evaluate<number>('derby.G.time');
  await wait(host, `derby.G.time >= ${settledTime + 0.25}`);
  const later = await panelMotion(host, car);
  for (const [index, rest] of settled.entries())
    assert(
      later[index]?.every((value, component) => Math.abs(value - (rest[component] ?? value)) < 0.000001),
      'tightened panel remains still',
    );
  await picture(host, car, join(OUTPUT, 'derby-body-tighten-repaired.png'));
  await startPanelJob(replica, 'trunk');
  await host.evaluate(`derby.hitCar(derby.G.cars[${car}],20,null,'rear','crash',{x:0,y:.5,z:-2},8)`);
  await wait(replica, `!derby.G.cars[${car}].parts.trunk && !${MECHANIC}.game`);
  assert.equal(
    await replica.evaluate(
      `derby.mechTasks(derby.G.humans[0].car).some(task => task.kind === 'panel' && task.name === 'trunk')`,
    ),
    false,
  );
  // A leftover completion tap can start another task, but cannot complete the vanished panel job.
  await press(replica, 'Space', ' ', 32, `${MECHANIC}.game?.task.kind !== 'panel'`);
  assert.equal(await host.evaluate(`!!derby.G.cars[${car}].parts.trunk`), false);
  await host.evaluate(
    `for (const c of derby.G.cars) if(c.idx !== ${car} && c.alive) derby.damageCar(c,1000,null,'crash')`,
  );
  await wait(host, "derby.G.state === 'over'");
  for (const page of [host, replica]) {
    await page.click('#statsBtn');
    await wait(page, "document.querySelector('.competition-dialog[open] table')");
    const row = await page.evaluate<string[]>(`(() => {
      const table = [...document.querySelectorAll('.competition-dialog table')].find(table => [...table.querySelectorAll('th')].some(th => th.textContent === 'Championship pts'));
      return [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)).find(row => row[0] === ${JSON.stringify(crew)});
    })()`);
    assert.equal(row[1], '2', 'only the two completed panel jobs count, with no stale or duplicate award');
    assert.equal(row[6], '20', 'two successful tightening jobs earn twenty mechanic championship points');
    await page.click('.competition-dialog header button');
  }
  console.log(
    'PASS: replica keyboard tightening, rejected first completion waits/retries for host confirmation, closed panels, cancelled detached job, exactly two jobs and twenty championship points',
  );
}

try {
  await hub.listen();
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string })
    .version;
  const url = `http://127.0.0.1:${hub.port}/derby01/@${version}/?room=BODY${Date.now()}&debug&test`;
  for (const [width, height] of [
    [1280, 720],
    [640, 360],
  ] as const) {
    browsers.push(
      await launchChrome({
        profile: mkdtempSync(join(WORK, 'profile-')),
        headless: true,
        width,
        height,
        startMs: 60000,
        args: flags,
      }),
    );
  }
  const first = browsers[0],
    second = browsers[1];
  assert(first && second);
  const A = await first.open(url);
  await wait(A, "window.derby && derby.G.state === 'menu' && derby.net.role === 'host'");
  await skipFirstRunGuide(A);
  const B = await second.open(url);
  await wait(B, "window.derby && derby.net.role === 'replica'");
  await skipFirstRunGuide(B);
  await A.click('#startBtn');
  for (const page of [A, B])
    await wait(page, "derby.G.state === 'playing' && derby.G.humans.length > 0 && derby.G.cars.length > 0");
  await freeze(A);
  const car = await A.evaluate<number>('derby.G.humans[0].car.idx');
  const seat = await A.evaluate<number>('derby.G.humans[0].seat');
  await press(A, 'KeyC', 'c', 67, `derby.G.humans[0].seat !== ${seat}`);
  await freeze(A);
  await press(A, 'Escape', 'Escape', 27, 'derby.G.menuOpen');
  await A.click('#resumeBtn');
  await wait(A, '!derby.G.menuOpen');
  await A.click('#soundBtn');
  await A.evaluate(
    `(() => { const s = document.querySelector('[data-picture]'); s.value = 'performance'; s.dispatchEvent(new Event('change')); })()`,
  );
  await A.click('[aria-label="Close sound controls"]');
  await A.click('#resumeBtn');
  await wait(
    A,
    "!derby.G.menuOpen && document.querySelector('#gl').width * document.querySelector('#gl').height <= 650000",
  );
  const before = await A.evaluate<Inventory>(inventory(car));
  assert(before.interior && before.triangles <= 400, 'interior stays within three shared low-polygon meshes');
  await picture(A, car, join(OUTPUT, 'derby-body-damage-before.png'));
  await A.evaluate(`(() => {
    const c = derby.G.cars[${car}];
    derby.hitCar(c, 1, null, 'lf', 'crash', {x:.95,y:.5,z:.5}, 2);
    derby.hitCar(c, 1, null, 'front', 'gun', {x:0,y:.5,z:2}, 20);
  })()`);
  assert.deepEqual(
    (await A.evaluate<Inventory>(inventory(car))).panels,
    before.panels,
    'light knocks and paintballs retain bodywork',
  );
  const looseTime = await A.evaluate<number>(`(() => {
    const c = derby.G.cars[${car}];
    for (const [zone, x, z] of [['front',0,2], ['rear',0,-2], ['lf',.95,.5], ['rf',-.95,.5], ['lr',.95,-.5], ['rr',-.95,-.5]])
      derby.hitCar(c,20,null,zone,'crash',{x,y:.5,z},8);
    return derby.G.time;
  })()`);
  const loose = await A.evaluate<Inventory>(inventory(car));
  assert(
    loose.alive && loose.anchored,
    'first qualifying impacts retain a living car and body-anchored turret',
  );
  assert.deepEqual(loose.panels, before.panels, 'even a strong first impact leaves each panel attached');
  for (const name of BODY_PANELS) {
    assert(loose.bodywork[name].wear >= 6);
    assert.equal(loose.bodywork[name].looseSince, looseTime);
  }
  await wait(B, `Object.values(derby.G.cars[${car}].bodywork).every(panel => panel.looseSince !== null)`);
  const replicaLoose = await B.evaluate<Inventory>(inventory(car));
  assert.deepEqual(replicaLoose.panels, loose.panels);
  for (const name of BODY_PANELS) {
    assert(
      Math.abs(replicaLoose.bodywork[name].wear - loose.bodywork[name].wear) < 0.01,
      `${name} replica wear matches`,
    );
    assert(
      Math.abs((replicaLoose.bodywork[name].looseSince ?? -1) - looseTime) < 0.01,
      `${name} replica loose age matches`,
    );
  }
  await assertPanelMotion(A, car, 'host');
  await assertPanelMotion(B, car, 'replica');
  await picture(A, car, join(OUTPUT, 'derby-body-damage-loose.png'));
  await wait(A, `derby.G.time >= ${looseTime + 0.8}`);
  const anchoredDistance = await A.evaluate<number>(`(() => {
    const c = derby.G.cars[${car}], T = derby.THREE;
    c.body.updateWorldMatrix(true, true);
    const position = c.turrets.hood.base.getWorldPosition(new T.Vector3());
    derby.hitCar(c,20,null,'lf','crash',{x:.95,y:.5,z:.5},8);
    derby.hitCar(c,20,null,'front','crash',{x:0,y:.5,z:2},8);
    c.body.updateWorldMatrix(true, true);
    const distance = position.distanceTo(c.turrets.hood.base.getWorldPosition(new T.Vector3()));
    c.sys.tireHp[0]=40;
    derby.hitCar(c,10,null,'lf','crash',{x:.71,y:.5,z:1.281},9);
    return distance;
  })()`);
  const damaged = await A.evaluate<Inventory>(inventory(car));
  assert(damaged.alive, 'progressive damage is exercised before a wreck');
  assert(!damaged.panels.includes('L_Door_Front') && !damaged.panels.includes('car_hood'));
  assert(
    damaged.interior && damaged.anchored && anchoredDistance < 0.000001,
    'cabin and functional turret remain on chassis',
  );
  assert.equal(damaged.attached[0], false);
  assert.equal(damaged.wheelOff[0], true);
  await wait(
    B,
    `!derby.G.cars[${car}].parts.L_Door_Front && !derby.G.cars[${car}].parts.car_hood && derby.G.cars[${car}].sys.wheelOff[0]`,
  );
  const replica = await B.evaluate<Inventory>(inventory(car));
  assert.deepEqual(replica.panels, damaged.panels, 'replica detail matches host panel inventory');
  assert.deepEqual(replica.attached, damaged.attached);
  assert.deepEqual(replica.wheelOff, damaged.wheelOff);
  assert(replica.interior && replica.anchored);
  const damageTime = await A.evaluate<number>('derby.G.time');
  await wait(A, `derby.G.time >= ${damageTime + 2}`);
  await picture(A, car, join(OUTPUT, 'derby-body-damage-after.png'));
  console.log(
    'PASS: setup, seat, pause/resume, Older laptop budget, six loose panels, host/replica hinge motion, later detachment, anchored turret and wheel detail',
  );
  await mechanicRepairs(A, B);
  await A.flushConsole();
  assert.deepEqual(
    A.console.filter((line) => /^error|exception|TypeError|ReferenceError|derby01:/i.test(line)),
    [],
  );
  await first.close();
  await wait(
    B,
    "derby.net.role === 'host' && ['countdown','playing'].includes(derby.G.state) && derby.G.humans.length > 0",
  );
  await freeze(B);
  const fresh = await B.evaluate<Inventory>(inventory(car));
  assert.deepEqual(fresh.panels, before.panels, 'takeover intentionally starts a fresh intact round');
  assert(fresh.interior && fresh.attached.every(Boolean) && fresh.wheelOff.every((value) => !value));
  for (const name of BODY_PANELS)
    assert.deepEqual(fresh.bodywork[name], { wear: 0, looseSince: null, generation: 0 });
  await press(B, 'Escape', 'Escape', 27, 'derby.G.menuOpen');
  await B.click('#setupBtn');
  await wait(B, "derby.G.state === 'menu'");
  await B.click('#startBtn');
  await wait(B, "derby.G.state === 'playing' && derby.G.humans.length > 0");
  assert(
    (await B.evaluate<Inventory>(inventory(car))).interior,
    'interior shared geometry survives cleanup and restart',
  );
  await B.flushConsole();
  assert.deepEqual(
    B.console.filter((line) => /^error|exception|TypeError|ReferenceError|derby01:/i.test(line)),
    [],
  );
  console.log(`PASS: fresh-round takeover, menu/restart, no browser errors. Proof images: ${OUTPUT}`);
} finally {
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  await hub.close();
}
process.exit(0);
