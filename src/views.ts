import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import { setHtml } from './browser-dom.ts';
import { createChaseState, advanceChaseOrbit, type ChaseState } from './gameplay/camera-state.ts';
import { deviceInfo } from './gameplay/devices.ts';
import { gunAt, isGunSeat, gunKey } from './gameplay/guns.ts';
import { bindHumanHud } from './hud.ts';
import type { LocalHuman, HumanHud, HudTextKey } from './human-types.ts';
import * as THREE from 'three';
import {
  $,
  SEATS,
  SEAT_INSIDE,
  TEAMS,
  TURRETS,
  _v1,
  _v2,
  clamp,
  damp,
  lerp,
  pick,
  rand,
  wrapPi,
} from './core.ts';
import { OBSTACLES, arenaNormal, arenaSDF, fitRenderer, renderer, scene } from './world.ts';
import { MENU_CAM } from './arena-state.ts';
import { G } from './state.ts';
import { particleScale } from './fx.ts';
import { SFX } from './audio.ts';
import { drawPaintOverlay } from './paint.ts';
import { drawRadarScreen } from './radar.ts';
import { POINTS, burnPoints } from './score.ts';
import { _dir, raycast } from './combat.ts';
import { aimDir, rayBox } from './gameplay/geometry.ts';
import { carAlerts, drawJam, drawMechanic } from './mechanic.ts';
import { syncTouch } from './touch.ts';

// =====================================================================
//  Split screen layout: rows of viewports, aiming for ~3:2 tiles
// =====================================================================
function computeLayout(n: number, W: number, H: number): { x: number; y: number; w: number; h: number }[] {
  W = Math.max(1, W);
  H = Math.max(1, H); // (a minimised window is 0 x 0)
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  let best = null,
    bestScore = Infinity;
  for (let rows = 1; rows <= n; rows++) {
    const perRow = Math.ceil(n / rows);
    if ((rows - 1) * perRow >= n) continue;
    let score = 0;
    const rects = [];
    let left = n;
    for (let r = 0; r < rows; r++) {
      const cols = Math.min(perRow, left);
      left -= cols;
      const w = W / cols,
        h = H / rows;
      score += cols * Math.abs(Math.log(w / h / 1.5));
      // cut on rounded edges, so neighbouring tiles meet without a gap
      const y0 = Math.round(r * h),
        y1 = Math.round((r + 1) * h);
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round(c * w),
          x1 = Math.round((c + 1) * w);
        rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = rects;
    }
  }
  if (!best) throw new Error('No viewport layout found');
  return best;
}

// =====================================================================
//  Cameras
// =====================================================================
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function chaseCamera(
  cam: THREE.PerspectiveCamera,
  car: Car,
  h: ChaseState,
  dt: number,
  dist = 6.6,
  height = 2.4,
  autoOrbit = 0,
) {
  const sp = Math.hypot(car.vel.x, car.vel.z);
  const yaw = advanceChaseOrbit(h, car.yaw, dt, autoOrbit);
  const d = dist + sp * 0.045;
  const tx = car.pos.x - Math.sin(yaw) * d,
    tz = car.pos.z - Math.cos(yaw) * d;
  h.camY = damp(h.camY ?? car.pos.y, car.pos.y, 6, dt);
  cam.position.set(tx, h.camY + height, tz);
  // don't end up behind the barrier
  const s = arenaSDF(tx, tz);
  if (s > -0.8) {
    arenaNormal(tx, tz, _v1);
    cam.position.x -= _v1.x * (s + 0.8);
    cam.position.z -= _v1.z * (s + 0.8);
    cam.position.y += Math.min(2, s + 0.8) * 0.6;
  }
  pullCameraOutOfBuildings(cam.position, car.pos.x, car.pos.y + 1.6, car.pos.z);
  cam.lookAt(car.pos.x + Math.sin(yaw) * 1.6, car.pos.y + 1.15, car.pos.z + Math.cos(yaw) * 1.6);
}

// If a building sits between the car and its chase camera, move the camera in front of the wall.
const _camO = new THREE.Vector3(),
  _camD = new THREE.Vector3();
function pullCameraOutOfBuildings(camPos: THREE.Vector3, x: number, y: number, z: number) {
  _camO.set(x, y, z);
  _camD.copy(camPos).sub(_camO);
  const len = _camD.length();
  if (len < 0.1) return;
  _camD.divideScalar(len);
  let best = len;
  for (const o of OBSTACLES) {
    if (o.kind !== 'box' || o.h < 2.4) continue;
    const t = rayBox(_camO, _camD, o.x, 0, o.z, o.yaw, o.hw, o.h, o.hl, best);
    if (t !== null && t < best) best = t;
  }
  if (best < len) camPos.copy(_camO).addScaledVector(_camD, Math.max(0.6, best - 0.4));
}

export function updateCamera(h: LocalHuman, dt: number) {
  const cam = h.cam;
  let fov = 72;
  if (h.dead || !h.car.alive) {
    h.watchT += dt;
    if (h.watchT > 3 && (!h.watch || !h.watch.alive || h.watch === h.car)) {
      const alive = G.cars.filter((c) => c.alive);
      h.watch = alive.find((c) => c.team === h.car.team) || alive[0] || h.watch;
    }
    chaseCamera(cam, h.watch || h.car, h, dt, 9, 3.6, 0.35);
  } else if (h.seat === 0) {
    const car = h.car;
    h.boostFov = damp(h.boostFov || 0, car.boosting ? 8 : 0, 4, dt); // nitro: a little wider, for the speed
    fov += h.boostFov;
    if (h.camMode === 'chase') chaseCamera(cam, car, h, dt);
    else {
      // from the driver's seat, through the windshield (paint, cracks and wipers and all)
      const e = requireValue(SEATS[0]).eye ?? requireValue(SEAT_INSIDE[0]);
      car.body.updateWorldMatrix(true, false);
      cam.position
        .set(requireValue(e[0]), requireValue(e[1]), requireValue(e[2]))
        .applyMatrix4(car.body.matrixWorld);
      car.body.getWorldQuaternion(cam.quaternion).multiply(_qFlip);
      h.camYaw = car.yaw;
      fov = 74 + h.boostFov;
    }
  } else if (h.seat === 3) {
    // the mechanic rides up front in the passenger seat, looking out through the windshield
    const car = h.car,
      e = requireValue(SEATS[3]).eye ?? requireValue(SEAT_INSIDE[3]);
    car.body.updateWorldMatrix(true, false);
    cam.position
      .set(requireValue(e[0]), requireValue(e[1]), requireValue(e[2]))
      .applyMatrix4(car.body.matrixWorld);
    car.body.getWorldQuaternion(cam.quaternion).multiply(_qFlip);
    h.camYaw = car.yaw;
    fov = 76;
  } else {
    // the turret camera, seen through the gunner's goggles: just over the shoulder of the little turret
    const car = h.car,
      g = gunAt(car, h.seat),
      t = TURRETS[gunKey(h.seat)],
      m = t.pos;
    aimDir(g.yaw, g.pitch, _dir);
    car.root.updateWorldMatrix(true, false);
    const pivot = _v2.set(m[0], m[1] + 0.17, m[2]).applyMatrix4(car.root.matrixWorld);
    cam.position.copy(pivot).addScaledVector(_dir, -t.cam[0]);
    cam.position.y += t.cam[1];
    _e.set(g.pitch + t.cam[2] + g.recoil * 0.01, g.yaw + Math.PI, 0);
    cam.quaternion.setFromEuler(_e);
    fov = lerp(72, 40, g.zoom);
  }
  // shake
  if (h.shake > 0.001) {
    const s = h.shake * h.shake * 0.35;
    cam.position.x += rand(-s, s);
    cam.position.y += rand(-s, s) * 0.6;
    cam.position.z += rand(-s, s);
    cam.rotateZ(rand(-s, s) * 0.12);
    h.shake = Math.max(0, h.shake - dt * 2.2);
  }
  // wide enough horizontally in narrow split-screen tiles
  const aspect = h.vp.w / h.vp.h;
  const minH = (78 * Math.PI) / 180;
  const needV = (2 * Math.atan(Math.tan(minH / 2) / aspect) * 180) / Math.PI;
  cam.fov = Math.max(fov, Math.min(needV, 100) * (fov / 72));
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
}

// Every frame: where is each human gunner's crosshair pointing?
export function updateAimPoints() {
  for (const h of G.humans) {
    if (h.dead || !isGunSeat(h.seat) || !h.car.alive) continue;
    const g = gunAt(h.car, h.seat);
    h.cam.getWorldDirection(_v1);
    const o = h.cam.position;
    const hit = raycast(o, _v1, 220, h.car);
    g.aimPoint.copy(o).addScaledVector(_v1, hit ? hit.t : 220);
  }
}

// =====================================================================
//  HUD (DOM overlay per viewport; the mechanic also gets a canvas)
// =====================================================================
const HINTS = {
  kbm: [
    'W A S D drive · Space handbrake · Shift nitro · V camera · C change seat',
    'Mouse aim · Click fire · Right-click zoom · C change seat',
  ],
  wasd: [
    'W A S D drive · Space handbrake · Shift nitro · V camera · C change seat',
    'W A S D aim · Space fire · C change seat',
  ],
  arrows: [
    'Arrows drive · Enter handbrake · R-Shift nitro · , camera · . change seat',
    'Arrows aim · Enter fire · . change seat',
  ],
  mouse: [
    'Move mouse to steer · Left gas · Right brake · Middle change seat',
    'Aim · Left fire · Middle-click change seat',
  ],
  pad: [
    'L-stick steer · RT gas · LT brake · A handbrake · X nitro · B camera · Y change seat',
    'R-stick aim · RT fire · LT zoom · Y change seat',
  ],
  touch: [
    'Left thumb steers · right thumb: GAS, BRAKE, NITRO',
    'Drag to aim · hold FIRE, and slide it to aim too',
  ],
};
function hintFor(h: LocalHuman) {
  const device = h.device.startsWith('pad') ? 'pad' : h.device;
  const set = HINTS[Object.hasOwn(HINTS, device) ? (device as keyof typeof HINTS) : 'kbm'];
  if (h.seat === 0) return requireValue(set[0]);
  return requireValue(set[1]);
}

export function buildHud() {
  const root = $('#hud');
  root.innerHTML = '';
  for (const h of G.humans) {
    const el = document.createElement('div');
    el.className = h.device === 'touch' ? 'vp touch' : 'vp'; // (touch: the HUD makes room for the thumbs)
    el.innerHTML = `
      <canvas class="vp-paint"></canvas>
      <canvas class="vp-canvas"></canvas>
      <div class="vp-tag"><span class="pn"></span><span class="role"></span><span class="dev"></span></div>
      <div class="cross"></div><div class="hitmark"></div><div class="dmgflash"></div>
      <div class="vp-msg"></div><div class="lockhint hidden">Click to aim with the mouse</div>
      <div class="vp-burn"></div><div class="vp-pts"></div>
      <div class="camfeed"><i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br br2"></i><span class="camtag"></span><span class="camdata"></span></div>
      <div class="vp-status"></div>
      <div class="vp-hp"><div class="cap"><span class="carname"></span><span class="hpnum"></span></div><div class="bar"><i></i></div></div>
      <canvas class="vp-map"></canvas>
      <div class="vp-info"><div class="big"></div><div class="small"></div><div class="meter"><i></i></div></div>
      <div class="vp-hint"></div>
      <div class="vp-side"><div class="vp-scores"></div><div class="vp-feed"></div></div>`;
    $('.pn', el).textContent = h.name; // (names and labels go in as text, never as markup)
    $('.dev', el).textContent = deviceInfo(h.device)?.label ?? h.device;
    root.appendChild(el);
    h.hud = bindHumanHud(el);
  }
  layoutViews();
}

function layoutViews() {
  const rects = computeLayout(G.humans.length, window.innerWidth, window.innerHeight);
  G.humans.forEach((h, i) => {
    h.vp = requireValue(rects[i]);
    if (!h.hud) return;
    Object.assign(h.hud.el.style, {
      left: h.vp.x + 'px',
      top: h.vp.y + 'px',
      width: h.vp.w + 'px',
      height: h.vp.h + 'px',
    });
    // radar screen in the bottom-right corner, scaled to the tile; speed / heat read-out sits above it
    // (by touch the radar is smaller, up top, and the read-out between the thumbs)
    const touch = h.device === 'touch';
    const mh = Math.round(
        touch ? clamp(Math.min(h.vp.w, h.vp.h) * 0.25, 72, 150) : clamp(h.vp.h * 0.34, 90, 230),
      ),
      mw = mh;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    Object.assign(h.hud.map.style, { width: mw + 'px', height: mh + 'px' });
    h.hud.map.width = Math.round(mw * dpr);
    h.hud.map.height = Math.round(mh * dpr);
    h.hud.info.style.bottom = touch ? '' : `calc(${mh + 18}px + var(--sb))`;
    h.hud.paint.width = Math.round(h.vp.w);
    h.hud.paint.height = Math.round(h.vp.h);
    h.hud.last.paintOn = true; // force a clear
  });
}

function setText(hud: HumanHud, key: HudTextKey, el: HTMLElement, text: string) {
  if (hud.last[key] !== text) {
    hud.last[key] = text;
    el.textContent = text;
  }
}

export function updateHud(dt: number) {
  for (const h of G.humans) {
    const u = h.hud;
    if (!u) continue;
    const car = h.car;
    const dead = h.dead || !car.alive;
    const mech = !dead && h.seat === 3;
    if (u.last.team !== car.team) {
      u.last.team = car.team;
      u.el.style.setProperty('--team', requireValue(TEAMS[car.team]).ui);
    }
    if (u.last.mech !== mech) {
      u.last.mech = mech;
      u.el.classList.toggle('mech', mech);
    }
    // the gunners sit in the back with goggles on, watching the camera on their turret
    const camFeed = !dead && isGunSeat(h.seat);
    if (u.last.camFeed !== camFeed) {
      u.last.camFeed = camFeed;
      u.el.classList.toggle('cam', camFeed);
    }
    if (camFeed) {
      const gg = gunAt(car, h.seat),
        rel = wrapPi(gg.yaw - car.yaw - TURRETS[gunKey(h.seat)].center);
      setText(u, 'camtag', u.camtag, `● REC  ${h.seat === 1 ? 'HOOD' : 'TRUNK'} CAM`);
      setText(
        u,
        'camdata',
        u.camdata,
        `PAN ${rel >= 0 ? '+' : ''}${Math.round(rel * 57.3)}° · TILT ${Math.round(gg.pitch * 57.3)}°${gg.zoom > 0.5 ? ' · ZOOM 2×' : ''}`,
      );
    }
    const g = isGunSeat(h.seat) ? gunAt(car, h.seat) : null;
    const jam = !dead && !!g && g.jam;
    if (u.last.jam !== jam) {
      u.last.jam = jam;
      u.el.classList.toggle('jam', jam);
      if (!jam) drawJam(h);
    }
    setText(u, 'role', u.role, dead ? 'WRECKED' : requireValue(SEATS[h.seat]).role);
    setText(u, 'car', u.carname, `CAR #${car.num} · CHASSIS`);
    setText(u, 'hp', u.hpnum, `${Math.ceil(car.hp)}`);
    u.hpbar.style.width = `${car.hp}%`;
    u.cross.style.display = !dead && g ? '' : 'none';
    // hit marker + damage flash
    h.hitMark = Math.max(0, h.hitMark - dt * 7);
    u.hit.classList.toggle('on', h.hitMark > 0.2);
    if (h.killMark > 0) h.killMark = Math.max(0, h.killMark - dt * 1.2);
    u.hit.classList.toggle('kill', h.killMark > 0);
    h.dmgFlash = Math.max(0, h.dmgFlash - dt * 1.8);
    u.flash.style.opacity = h.dmgFlash.toFixed(2);
    // right-hand info
    let big = '',
      small = '',
      meter = -1;
    if (dead || mech) {
      /* nothing */
    } else if (h.seat === 0) {
      big = `${Math.round(Math.hypot(car.vel.x, car.vel.z) * 3.6)}`;
      small = car.boosting ? 'NITRO!' : car.mods.power <= 0 ? 'NO POWER' : 'KM/H · NITRO';
      meter = car.boostFuel;
    } else if (g) {
      big = g.jam ? 'JAMMED' : g.overheat ? 'HOT!' : h.seat === 1 ? 'HOOD GUN' : 'TRUNK GUN';
      small = g.jam ? 'CLEAR IT!' : g.overheat ? 'OVERHEATED' : g.heat > 0.75 ? 'TOO HOT · EASE OFF' : 'HEAT';
      meter = 1 - g.heat;
    }
    setText(u, 'big', u.big, big);
    setText(u, 'small', u.small, small);
    u.meter.style.display = meter < 0 ? 'none' : '';
    if (meter >= 0) u.meterFill.style.width = `${(clamp(meter, 0, 1) * 100).toFixed(1)}%`;
    // a burn in progress: how long, and what it's worth so far
    const B = car.burn,
      burning = !dead && !!B && B.on && B.t > 0.4;
    setText(
      u,
      'burn',
      u.burn,
      burning
        ? `BURN ${B.t.toFixed(1)}s · ${B.t >= POINTS.burn.min ? '+' + burnPoints(B.t) : 'hold it'}`
        : '',
    );
    if (u.last.burnOn !== burning) {
      u.last.burnOn = burning;
      u.burn.classList.toggle('on', burning);
    }
    // car problems everybody should shout about
    const chips = dead
      ? ''
      : carAlerts(car)
          .map(([t, lvl]) => `<span class="chip ${lvl}">${t}</span>`)
          .join('');
    if (u.last.chips !== chips) {
      u.last.chips = chips;
      u.status.innerHTML = chips;
    }
    // messages
    let msg = '';
    if (dead && G.state !== 'over')
      msg = `WRECKED<small>${h.watch && h.watch !== car ? `Watching car #${h.watch.num} · ` : ''}${h.device.startsWith('pad') ? 'Y' : h.device === 'arrows' ? '.' : h.device === 'mouse' ? 'Middle-click' : h.device === 'touch' ? 'Tap VIEW' : 'C'} to switch view</small>`;
    if (u.last.msg !== msg) {
      u.last.msg = msg;
      u.msg.innerHTML = msg;
    }
    const lockNeeded =
      (h.device === 'kbm' || h.device === 'mouse') &&
      !dead &&
      (g || h.device === 'mouse') &&
      document.pointerLockElement !== renderer.domElement;
    u.lock.classList.toggle('hidden', !lockNeeded);
    h.hintT = Math.max(0, (h.hintT ?? 8) - dt);
    setText(u, 'hint', u.hint, dead || mech ? '' : hintFor(h));
    u.hint.style.opacity = h.hintT > 0 ? '1' : '0';
    drawPaintOverlay(h);
    if (mech) drawMechanic(h);
    else if (jam) drawJam(h);
    if (!mech) drawRadarScreen(h);
  }
  syncTouch();
}

// Kill feed + team scores live in each player's corner; globally only when nobody plays.
export function updateScores() {
  const el = $('#scores');
  if (G.state === 'menu') {
    setHtml(el, '');
    return;
  }
  const teams = [...new Set(G.cars.map((c) => c.team))].sort((a, b) => a - b);
  const html = teams
    .map((t) => {
      const alive = G.cars.filter((c) => c.team === t && c.alive).length;
      return `<span style="--c:${requireValue(TEAMS[t]).ui}" class="${alive ? '' : 'out'}">${requireValue(TEAMS[t]).name}<b>${Math.round(requireValue(G.points[t]))}</b>${G.teamScores[t] ? `<i>★${G.teamScores[t]}</i>` : ''}</span>`;
    })
    .join('');
  const targets = G.humans.length
    ? G.humans.map((h) => h.hud && h.hud.scores).filter((node): node is HTMLDivElement => !!node)
    : [el];
  if (G.humans.length) setHtml(el, '');
  for (const target of targets) setHtml(target, html);
}

export function setCenter(html: string) {
  setHtml($('#center'), html);
}

// =====================================================================
//  Rendering
// =====================================================================
const menuCam = new THREE.PerspectiveCamera(50, 1, 0.1, 4500);
scene.add(menuCam);
export function render(dt: number) {
  const W = window.innerWidth,
    H = window.innerHeight;
  const pr = renderer.getPixelRatio();
  renderer.setScissorTest(true);
  renderer.shadowMap.needsUpdate = true;
  SFX.listeners.length = 0;
  const views = [];
  if (G.state === 'menu' || !G.humans.length) {
    const t = performance.now() / 1000;
    const mc = MENU_CAM;
    menuCam.position.set(
      mc.cx + Math.sin(t * 0.07) * mc.rx,
      mc.h + Math.sin(t * 0.13) * 3,
      mc.cz + Math.cos(t * 0.07) * mc.rz,
    );
    menuCam.lookAt(mc.cx, 1, mc.cz);
    // watch-bots mode: follow the action
    if (G.state !== 'menu' && G.cars.length) {
      G.spec = G.spec || createChaseState(); // (it orbits on its own: no orbit input)
      if (!G.spec.car || !G.spec.car.alive || (G.spec.t = (G.spec.t || 0) + dt) > 9) {
        const alive = G.cars.filter((car) => car.alive);
        G.spec.car = alive.length ? pick(alive) : requireValue(G.cars[0]);
        G.spec.t = 0;
      }
      chaseCamera(menuCam, G.spec.car, G.spec, dt, 10, 4, 0.22);
    }
    const dc = window.derby?.debugCam; // fixed camera for screenshots (?debug): derby.debugCam = { pos: [x,y,z], look: [x,y,z] }
    if (dc) {
      menuCam.position.fromArray(dc.pos);
      menuCam.lookAt(_v1.fromArray(dc.look));
    }
    menuCam.aspect = W / H;
    menuCam.updateProjectionMatrix();
    views.push({ cam: menuCam, x: 0, y: 0, w: W, h: H });
  } else {
    for (const h of G.humans) views.push({ cam: h.cam, ...h.vp });
  }
  for (const v of views) SFX.listeners.push(v.cam.position);
  for (const v of views) {
    renderer.setViewport(v.x, H - v.y - v.h, v.w, v.h);
    renderer.setScissor(v.x, H - v.y - v.h, v.w, v.h);
    particleScale.value = (v.h * pr) / (2 * Math.tan((v.cam.fov * Math.PI) / 360));
    renderer.render(scene, v.cam);
  }
}

window.addEventListener('resize', () => {
  fitRenderer(); // (the pixel ratio changes with zoom, or on another screen)
  layoutViews();
});
