/** Real WebGL driver view: the windshield stays in its frame however cracked, and its paint lasts until wiped. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, type Chrome, type Page } from '@zirbel/engineering/browser';
import { createDevServer } from '../../tools/server.ts';
import { skipFirstRunGuide } from './onboarding.ts';

const ROOT = join(import.meta.dirname, '../..');
const WORK = mkdtempSync(join(tmpdir(), 'derby-windshield-'));
const OUTPUT = process.env['ARTIFACT_DIR'] ?? WORK;
mkdirSync(OUTPUT, { recursive: true });
const server = createDevServer(join(ROOT, 'dist/web'));
let browser: Chrome | null = null;
const car = 'derby.G.humans[0].car';
const wait = (page: Page, expression: string) => page.waitFor(expression, 60000);
// Share of the windshield the paint hides (alpha over half), and the alpha in a corner no blade reaches.
const painted = `(() => {
  const sh = ${car}.glass.shield, pixels = sh.g.getImageData(0, 0, sh.w, sh.h).data;
  let hidden = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 128) hidden++;
  return { hidden: hidden / (sh.w * sh.h), corner: sh.g.getImageData(4, 4, 1, 1).data[3], cover: sh.cover };
})()`;
type Painted = { hidden: number; corner: number; cover: number };

async function press(page: Page, code: string, key: string, number: number, observed: string): Promise<void> {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: number });
  try {
    await wait(page, observed);
  } finally {
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: number });
  }
}

async function after(page: Page, seconds: number, from: number): Promise<void> {
  await wait(page, `derby.G.time >= ${from + seconds}`);
}

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await launchChrome({
    profile: join(WORK, 'profile'),
    headless: true,
    width: 1280,
    height: 720,
    startMs: 60000,
    args: [
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.open(`http://127.0.0.1:${address.port}/?debug&test`);
  await wait(page, "window.derby && derby.G.state === 'menu'");
  await skipFirstRunGuide(page);
  await page.click('#startBtn');
  await wait(page, "derby.G.state === 'playing' && derby.G.humans[0]?.seat === 0");
  await page.evaluate(`for (const c of derby.G.cars) {
    for (const occupant of c.occ) if (occupant && occupant.kind === 'bot') delete occupant.bot;
    c.vel.set(0,0,0); c.ctrl.throttle = 0; c.ctrl.steer = 0;
  }`);
  await page.evaluate('derby.G.bullets.length = 0');
  if ((await page.evaluate('derby.G.humans[0].camMode')) !== 'cockpit')
    await press(page, 'KeyV', 'v', 86, "derby.G.humans[0].camMode === 'cockpit'");
  await wait(page, 'derby.G.goT <= 0');

  // Hard knocks and hits shatter the windshield; it stays in its frame, with its wipers.
  await page.evaluate(
    `for (let i = 0; i < 8; i++) derby.crackWindshield(${car}, 0.15 + i * 0.1, 0.3 + (i % 3) * 0.2, 3)`,
  );
  assert(
    await page.evaluate(`${car}.glass.shield.crack.shattered && ${car}.glass.shield.crack.level >= 0.42`),
  );
  assert(
    await page.evaluate(
      `${car}.shieldFilm.visible && ${car}.crackFilm.visible && ${car}.wiperArms.length === 2 && ${car}.wiperArms.every((arm) => arm.visible)`,
    ),
    'the shattered windshield, its paint film and its wipers stay on the car',
  );
  assert.equal(await page.evaluate(`'frontGlassOn' in ${car}.glassMat.userData.u`), false);

  // Paused, so the wipers stand still: a paintball on the shattered glass still lands and blocks the view,
  // and nothing takes it off.
  await press(page, 'Escape', 'Escape', 27, "derby.G.state === 'paused'");
  await page.evaluate(`(() => {
    const c = ${car}, sh = c.glass.shield;
    sh.g.clearRect(0, 0, sh.w, sh.h); sh.cover = 0;
    derby.paintHitCar(c, { x: 0, y: 1.2, z: 1.1 }, 2, 1, '#ff3df2');
    derby.paintHitCar(c, { x: 0.35, y: 1.1, z: 1.1 }, 2, 1, '#ff3df2');
    sh.g.fillStyle = '#ff3df2'; sh.g.fillRect(0, 0, 10, 10);
  })()`);
  const hit = await page.evaluate<Painted>(painted);
  assert(
    hit.hidden > 0.04 && hit.cover > 0,
    `paint lands on the shattered windshield: ${JSON.stringify(hit)}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(await page.evaluate<Painted>(painted), hit, 'no wiping while paused');
  await page.click('#resumeBtn');
  await wait(page, "derby.G.state === 'playing'");

  // Running, the blades thin it pass by pass; a corner they never reach keeps its paint.
  const start = await page.evaluate<number>('derby.G.time');
  const timeline: { t: number; hidden: number }[] = [];
  for (const t of [0, 0.5, 1, 2, 3, 5]) {
    await after(page, t, start);
    const now = await page.evaluate<Painted>(painted);
    timeline.push({ t, hidden: Math.round(now.hidden * 1000) / 1000 });
    if (t <= 3) await page.screenshot(join(OUTPUT, `derby-windshield-${t}s.png`));
    assert.equal(now.corner, hit.corner, `paint out of the blades' reach stays at ${t} s`);
  }
  const hidden = timeline.map((sample) => sample.hidden);
  for (let i = 1; i < hidden.length; i++)
    assert(
      requireNumber(hidden[i]) <= requireNumber(hidden[i - 1]),
      `paint only thins: ${JSON.stringify(timeline)}`,
    );
  assert(
    requireNumber(hidden[2]) > requireNumber(hidden[0]) * 0.4,
    `a hit still blocks the view after 1 s: ${JSON.stringify(timeline)}`,
  );
  assert(
    requireNumber(hidden[5]) < requireNumber(hidden[0]) * 0.5,
    `the wipers clear it: ${JSON.stringify(timeline)}`,
  );

  // The rear window can still be smashed out.
  await page.evaluate(
    `for (let i = 0; i < 4; i++) derby.crackGlassAt(${car}, { x: 0, y: 1.15, z: -1.1 }, 3)`,
  );
  assert(
    await page.evaluate(
      `${car}.glass.shield.crack.rearShattered && ${car}.glassMat.userData.u.rearGlassOn.value === 0`,
    ),
  );
  assert(await page.evaluate(`${car}.shieldFilm.visible && ${car}.wiperArms.every((arm) => arm.visible)`));

  // A new windscreen comes clean: no cracks, no paint, and the rear window back in.
  await page.evaluate(`derby.fitNewWindshield(${car})`);
  const fitted = await page.evaluate<Painted>(painted);
  assert.deepEqual(fitted, { hidden: 0, corner: 0, cover: 0 }, 'a new windscreen has no paint');
  assert(
    await page.evaluate(
      `!${car}.glass.shield.crack.shattered && ${car}.glass.shield.crack.level === 0 && ${car}.glassMat.userData.u.rearGlassOn.value === 1`,
    ),
  );

  await press(page, 'Escape', 'Escape', 27, "derby.G.state === 'paused'");
  await page.click('#setupBtn');
  await wait(page, "derby.G.state === 'menu'");
  await page.flushConsole();
  assert.deepEqual(
    page.console.filter((line) => /^error|exception|TypeError|ReferenceError|derby01:/i.test(line)),
    [],
  );
  console.log(
    `PASS: shattered windshield stays with its wipers, takes paint, holds it while paused, thins only under the blades (${JSON.stringify(timeline)}), rear window still falls out, a new windscreen comes clean, pause/resume/menu. Proof images: ${OUTPUT}`,
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
process.exit(0);

function requireNumber(value: number | undefined): number {
  assert(value !== undefined);
  return value;
}
