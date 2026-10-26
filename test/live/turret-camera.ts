/** Real WebGL seat changes: turret feeds stay clear; the driver's windshield retains its effects. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, type Chrome, type Page } from '@zirbel/engineering/browser';
import { createDevServer } from '../../tools/server.ts';
import { skipFirstRunGuide } from './onboarding.ts';

const ROOT = join(import.meta.dirname, '../..');
const WORK = mkdtempSync(join(tmpdir(), 'derby-turret-'));
const OUTPUT = process.env['ARTIFACT_DIR'] ?? WORK;
mkdirSync(OUTPUT, { recursive: true });
const server = createDevServer(join(ROOT, 'dist/web'));
let browser: Chrome | null = null;
const human = 'derby.G.humans[0]';
const wait = (page: Page, expression: string) => page.waitFor(expression, 60000);
const paintedPixels = `(() => {
  const h = ${human}, cv = h.hud.paint;
  const pixels = h.hud.paintCtx.getImageData(0, 0, cv.width, cv.height).data;
  let count = 0; for(let i = 3; i < pixels.length; i += 4) if(pixels[i]) count++;
  return count;
})()`;

async function press(page: Page, code: string, key: string, number: number, observed: string): Promise<void> {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: number });
  try {
    await wait(page, observed);
  } finally {
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: number });
  }
}

async function changeSeat(page: Page, seat: number): Promise<void> {
  await press(page, 'KeyC', 'c', 67, `${human}.seat === ${seat}`);
  await page.evaluate(`for (const c of derby.G.cars) for (const occupant of c.occ)
    if (occupant && occupant.kind === 'bot') delete occupant.bot`);
  await page.evaluate('derby.G.bullets.length = 0');
}

async function assertClearFeed(page: Page, seat: 1 | 2): Promise<void> {
  await changeSeat(page, seat);
  const lens = `${human}.car.glass.${seat === 1 ? 'hood' : 'trunk'}`;
  await page.evaluate(`(() => {
    const gl = ${lens}; gl.g.clearRect(0,0,gl.w,gl.h); gl.cover = 0; gl.dirty = true;
    gl.crack = ${human}.car.glass.shield.crack; gl.wipers = ${human}.car.glass.shield.wipers;
  })()`);
  await wait(page, `${paintedPixels} === 0`);
  // Simulate a stale cached driver image, as after a viewport/seat transition, on the actual HUD canvas.
  await page.evaluate(`(() => {
    const h = ${human}; h.hud.paintCtx.fillStyle = '#ff00ff';
    h.hud.paintCtx.fillRect(10, 10, 40, 40); h.hud.last.paintOn = true;
  })()`);
  await wait(page, `${paintedPixels} === 0`);
  const time = await page.evaluate<number>('derby.G.time');
  await wait(page, `derby.G.time >= ${time + 0.3}`);
  assert.equal(
    await page.evaluate(paintedPixels),
    0,
    'gun feed stays transparent while windshield effects run',
  );
  assert(await page.evaluate(`${human}.car.glass.shield.crack.level > 0`));
  await page.screenshot(join(OUTPUT, `derby-turret-${seat === 1 ? 'hood' : 'trunk'}.png`));
  await page.evaluate(`${lens}.splat(.5,.45,65,'#ff00ff')`);
  await wait(page, `${paintedPixels} > 0`);
  if (seat === 1) await page.screenshot(join(OUTPUT, 'derby-turret-camera-paint.png'));
  // A uniform paint fixture reveals any blade-shaped erasure or crack/wiper strokes in the real feed.
  await page.evaluate(`(() => {
    const gl = ${lens}; gl.g.fillStyle = '#ff00ff'; gl.g.fillRect(0,0,gl.w,gl.h);
    gl.cover = 1; gl.dirty = true;
  })()`);
  const paintedTime = await page.evaluate<number>('derby.G.time');
  await wait(page, `derby.G.time >= ${paintedTime + 0.3}`);
  const alpha = await page.evaluate<number[]>(`(() => {
    const gl = ${lens}; return [gl.g.getImageData(10,10,1,1).data[3],gl.g.getImageData(gl.w-10,gl.h-10,1,1).data[3]];
  })()`);
  assert(alpha[0] !== undefined && alpha[0] > 0 && alpha[0] < 255, 'camera paint fades without a wiper');
  assert.equal(alpha[0], alpha[1], 'distant paint samples fade uniformly');
  const range = await page.evaluate<{
    min: number;
    max: number;
    sourceMin: number;
    sourceMax: number;
    alpha: number;
    mode: string;
    minAt: number;
    maxAt: number;
  }>(`(() => {
    const h = ${human}, cv = h.hud.paint, pixels = h.hud.paintCtx.getImageData(0,0,cv.width,cv.height).data;
    let min = 255, max = 0,minAt=0,maxAt=0; for(let i=3;i<pixels.length;i+=4) {if(pixels[i]<min){min=pixels[i];minAt=(i-3)/4;}if(pixels[i]>max){max=pixels[i];maxAt=(i-3)/4;}}
    const gl=${lens}, source=gl.g.getImageData(0,0,gl.w,gl.h).data;
    let sourceMin=255,sourceMax=0;for(let i=3;i<source.length;i+=4){sourceMin=Math.min(sourceMin,source[i]);sourceMax=Math.max(sourceMax,source[i]);}
    return {min,max,sourceMin,sourceMax,alpha:gl.g.globalAlpha,mode:gl.g.globalCompositeOperation,minAt,maxAt};
  })()`);
  assert.equal(
    range.min,
    range.max,
    `camera feed adds no blade or crack strokes to uniform paint: ${JSON.stringify(range)}`,
  );
  await page.evaluate(
    `(() => {const gl = ${lens}; gl.g.clearRect(0,0,gl.w,gl.h);gl.cover=0;gl.dirty=true;gl.crack=null;gl.wipers=[];})()`,
  );
  await wait(page, `${paintedPixels} === 0`);
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
  await wait(page, `derby.G.state === 'playing' && ${human}?.seat === 0`);
  await page.evaluate(`for (const c of derby.G.cars) {
    for (const occupant of c.occ) if (occupant && occupant.kind === 'bot') delete occupant.bot;
    c.vel.set(0,0,0); c.ctrl.throttle = 0; c.ctrl.steer = 0;
  }`);
  await page.evaluate('derby.G.bullets.length = 0');
  await press(page, 'Escape', 'Escape', 27, "derby.G.state === 'paused'");
  await page.click('#resumeBtn');
  await wait(page, "derby.G.state === 'playing'");
  if ((await page.evaluate(`${human}.camMode`)) !== 'chase')
    await press(page, 'KeyV', 'v', 86, `${human}.camMode === 'chase'`);
  await page.evaluate(`(() => {
    const c = ${human}.car; derby.crackWindshield(c,.5,.5,1);
    c.glass.shield.splat(.5,.45,65,'#ff00ff');
  })()`);
  await wait(page, `${human}.hud.last.paintOn && ${paintedPixels} > 0`);
  const arm = await page.evaluate<number>(`${human}.car.wiperArms[0].rotation.z`);
  const time = await page.evaluate<number>('derby.G.time');
  await wait(page, `derby.G.time >= ${time + 0.3}`);
  assert(
    Math.abs((await page.evaluate<number>(`${human}.car.wiperArms[0].rotation.z`)) - arm) > 0.001,
    'driver wipers still move',
  );
  await wait(page, 'derby.G.goT <= 0');
  await page.screenshot(join(OUTPUT, 'derby-turret-driver-windshield.png'));
  await assertClearFeed(page, 1);
  await assertClearFeed(page, 2);
  await changeSeat(page, 3);
  await changeSeat(page, 0);
  await wait(page, `${human}.hud.last.paintOn && ${paintedPixels} > 0`);
  await press(page, 'KeyV', 'v', 86, `${human}.camMode === 'cockpit'`);
  await wait(page, `${paintedPixels} === 0 && ${human}.hud.last.paintOn === false`);
  assert(
    await page.evaluate(`${human}.car.glass.shield.crack.level > 0 && ${human}.car.wiperArms.length === 2`),
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
    `PASS: both clear turret feeds, stale overlay cleared, camera paint retained with uniform fade/no blades or cracks, driver windshield/wipers, seat changes, pause/resume/menu. Proof images: ${OUTPUT}`,
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
