import { requireValue } from './required-fields.ts';
import { requiredElement, dataValue, setHtml } from './browser-dom.ts';
import { beginCompetition, updateCompetition, finishCompetition, resetCompetition } from './competition.ts';
import { deviceInfo } from './gameplay/devices.ts';
import { gunAt } from './gameplay/guns.ts';
import type { Car } from './car-types.ts';
import type { LocalHuman, RemoteHuman } from './human-types.ts';
import { participantState } from './gameplay/participants.ts';
import * as THREE from 'three';
import { decodeSetup, type CarSetup, type Setup } from './setup.ts';
import {
  $,
  CARDIM,
  DEVICES,
  GUN_SEATS,
  STEP,
  TEAMS,
  _v1,
  _v2,
  buildFallbackTemplate,
  clamp,
  isHumanSlot,
  loadCarTemplate,
  rand,
} from './core.ts';
import {
  NAV,
  OBSTACLES,
  adaptQuality,
  arenaSDF,
  randomSpawns,
  renderer,
  scene,
  segmentClear,
} from './world.ts';
import { ARENA_ROOT, buildArena, townFor } from './arena.ts';
import { TOWN } from './arena-state.ts';
import { generateLayout } from './layout.ts';
import {
  TPL,
  createCar,
  dentCar,
  disposeCar,
  refreshOccupantVisuals,
  setTPL,
  settleBumper,
  syncCarVisual,
  tearOffBumper,
  updatePlayerTag,
} from './car.ts';
import { G } from './state.ts';
import { damageCar, hitCar, physicsStep } from './physics.ts';
import { resetBreakables, updateBreakables } from './breakables.ts';
import { CAR_BLURB, DEFAULT_KITS, KIT_NAMES, isKit } from './kit-data.ts';
import { showCarPreviews, stopCarPreviews } from './carpreview.ts';
import {
  GLOW,
  SMOKE,
  addSkid,
  clearDebris,
  nitroFlame,
  clearConfetti,
  clearSkids,
  confettiBurst,
  fireLick,
  skid,
  smokePuff,
  updateConfetti,
  updateDebris,
} from './fx.ts';
import { SFX } from './audio.ts';
import {
  clearPaint,
  crackGlassAt,
  crackWindshield,
  drawBalls,
  paintBurst,
  paintHitCar,
  updatePaint,
} from './paint.ts';
import { damageRadar, updateRadar } from './radar.ts';
import { updateBurn } from './score.ts';
import { updateBullets, updateGun } from './combat.ts';
import { carToWorld } from './gameplay/geometry.ts';
import {
  botDrive,
  botGun,
  defaultGunYaw,
  endInputFrame,
  makeBot,
  pollPads,
  switchSeat,
  updateHumanControls,
} from './control.ts';
import { usesMouse } from './device-mode.ts';
import { Input } from './gameplay/input.ts';
import {
  GAMES,
  TASK_GAME,
  botMechanic,
  breakAxle,
  breakTire,
  loseWheel,
  mechTasks,
  startFire,
  updateSystems,
} from './mechanic.ts';
import { clearDrops, giveDrop, spawnDrop, updateDrops } from './drops.ts';
import {
  buildHud,
  render,
  setCenter,
  updateAimPoints,
  updateCamera,
  updateHud,
  updateScores,
} from './views.ts';
import { withSeed } from './net/seeded.ts';
import { currentRole, isNetHost, isReplica } from './net/role.ts';
import { peerOfSlot } from './net/protocol.ts';
import { startNet } from './net/session.ts';
import { getSession, mySeat, nameOf, peerSeats, seatName, takeRevision } from './net/context.ts';
import { D, dataRevision } from './data.ts';
import {
  driveRemote,
  hostDebug,
  hostRoundStarted,
  hostSetupChanged,
  hostTickBegin,
  hostTickEnd,
} from './net/host.ts';
import { replicaDebug, replicaTick } from './net/replica.ts';
import { followSetup, touchScreen } from './touch.ts';
export type { CarSetup, Setup } from './setup.ts';

// =====================================================================
//  Setup (the start screen)
// =====================================================================
const SETUP_KEY = 'derby01.setup.v1';
const B = 'bot';
const MIN_CARS = 2,
  MAX_CARS = TEAMS.length; // one car per team colour
// seats: [driver, hood gunner, trunk gunner, mechanic]. Every seat is a bot or a player.
const SEAT_NAMES = ['Driver', 'Hood gun', 'Trunk gun', 'Mechanic'];
const SEAT_ORDER = [0, 3, 1, 2]; // as the setup lists them: the front seats first
const newMapSeed = () => 1 + Math.floor(Math.random() * 99999);
const isMapSeed = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 99999;
const newCar = (i: number, seats: string[] = [B, B, B, B]): CarSetup => ({
  team: i,
  kit: requireValue(DEFAULT_KITS[i % DEFAULT_KITS.length]),
  seats,
});
function defaultSetup(): Setup {
  return {
    botSkill: 1,
    mapSeed: newMapSeed(),
    cars: Array.from({ length: 4 }, (_, i) => newCar(i, i === 0 ? ['kbm', B, B, B] : undefined)),
  };
}
function loadSetup(): Setup | null {
  try {
    return decodeSetup(JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null'), {
      devices: DEVICES,
      defaultKits: DEFAULT_KITS,
      isKit,
      maxCars: MAX_CARS,
      newMapSeed,
    });
  } catch {
    return null;
  } // storage can be disabled or contain invalid JSON
}
// Players on other screens are only seated for this session: their seats are kept as bots.
export function saveSetup() {
  const keep = {
    ...setup,
    cars: setup.cars.map((c) => ({ ...c, seats: c.seats.map((d) => (peerOfSlot(d) ? B : d)) })),
  };
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(keep));
  } catch {
    /* private mode or full: it just isn't kept */
  }
}
// Read in boot(): building it needs every module loaded (the kits).
let setup: Setup;
export const getSetup = (): Setup => setup;
export function setSetup(s: Setup) {
  setup = s;
}

// The town for a map number and a number of cars (or the hand-made one), the same on every screen: its
// random choices run seeded too. Built again when the data it is made from changes.
let builtMap = '';
export function buildMap(seed: number, cars: number) {
  const fixed = D.rounds.map === 'town';
  const key = JSON.stringify([
    fixed ? 0 : seed,
    fixed ? 0 : cars,
    fixed ? D.town : D.generator,
    D.pieces,
    D.prefabs,
  ]);
  if (key === builtMap) return;
  withSeed(Math.imul(seed, 2654435761), () => buildArena(townFor(seed, cars)));
  builtMap = key;
}

// ---- the players: every seat that isn't a bot's. A slot is a device here (DEVICES) or a player online ----
const seatOf = (slot: string): [number, number] | null => {
  for (let ci = 0; ci < setup.cars.length; ci++) {
    const si = requireValue(setup.cars[ci]).seats.indexOf(slot);
    if (si >= 0) return [ci, si];
  }
  return null;
};
const humansIn = (car: CarSetup) => car.seats.filter(isHumanSlot).length;
const slotName = (slot: string) =>
  deviceInfo(slot)?.label ?? (peerOfSlot(slot) ? `${seatName(peerOfSlot(slot))} · online` : 'CPU');
// in a fixed order, so the cards stay put when someone changes car: this screen's (by device), then those online
function players(): string[] {
  const rank = (s: string) =>
    Object.hasOwn(DEVICES, s) ? Object.keys(DEVICES).indexOf(s) : 100 + peerOfSlot(s);
  return setup.cars.flatMap((c) => c.seats.filter(isHumanSlot)).sort((a, b) => rank(a) - rank(b));
}
// the devices here that no one plays with yet (or `own`'s keys and mouse), gamepads once they've been seen, touch on a touch screen
function freeDevices(own = ''): string[] {
  const used = new Set(
    players()
      .filter((s) => s !== own && deviceInfo(s))
      .flatMap((s) => deviceInfo(s)?.uses),
  );
  return Object.keys(DEVICES).filter(
    (k) =>
      !deviceInfo(k)?.uses.some((r: string) => used.has(r)) &&
      (!k.startsWith('pad') || Input.pads[+requireValue(k[3])]) &&
      (k !== 'touch' || touchScreen()),
  );
}
// A player sits down; whoever sat there takes the seat they left (a bot stays a bot).
function sit(slot: string, ci: number, si: number) {
  const from = seatOf(slot),
    there = requireValue(setup.cars[ci]).seats[si];
  requireValue(setup.cars[ci]).seats[si] = slot;
  if (from && (from[0] !== ci || from[1] !== si))
    requireValue(setup.cars[from[0]]).seats[from[1]] = isHumanSlot(there) ? there : B;
}
// To another car: the same seat there unless a player has it, else a seat no player has, else swap seats with that player.
function toCar(slot: string, ci: number) {
  const from = seatOf(slot),
    role = from ? from[1] : 0,
    seats = requireValue(setup.cars[ci]).seats;
  if (!from || from[0] !== ci)
    sit(slot, ci, [role, ...SEAT_ORDER].find((s) => !isHumanSlot(seats[s])) ?? role);
}
// A new player drives a car of their own while one has no players; after that they join the car with the fewest.
function addPlayer(slot: string): boolean {
  if (seatOf(slot)) return true;
  const car = setup.cars.reduce((best, c) => (humansIn(c) < humansIn(best) ? c : best));
  const si = SEAT_ORDER.find((s) => !isHumanSlot(car.seats[s]));
  if (si === undefined) return false; // a player in every seat
  car.seats[si] = slot;
  return true;
}
function setCarCount(n: number) {
  n = clamp(n, MIN_CARS, MAX_CARS);
  if (n === setup.cars.length) return;
  while (setup.cars.length < n) setup.cars.push(newCar(setup.cars.length));
  for (const slot of setup.cars.splice(n).flatMap((c) => c.seats.filter(isHumanSlot))) addPlayer(slot); // those in the cars that go move over
  clearArena();
  buildMap(setup.mapSeed, setup.cars.length);
}
// On the start screen a gamepad joins with any button, and Start on a gamepad that has a seat starts the game.
function padJoin() {
  Input.pads.forEach((p, i) => {
    if (!p) return;
    const prev = Input.padPrev[i] || [],
      fresh = (k: number) => p.buttons[k] && !prev[k];
    if (!p.buttons.some((_, k) => fresh(k))) return;
    if (!seatOf('pad' + i)) {
      if (addPlayer('pad' + i)) renderSetup();
    } else if (fresh(9)) {
      SFX.init();
      startGame();
    }
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function playerCard(slot: string): HTMLElement {
  const seat = seatOf(slot);
  if (!seat) throw new Error('Player has no setup seat');
  const [ci, si] = seat,
    car = requireValue(setup.cars[ci]),
    online = !!peerOfSlot(slot);
  const card = document.createElement('div');
  card.className = 'player';
  card.style.setProperty('--team', requireValue(TEAMS[car.team]).ui);
  const devices = online ? [] : [slot, ...freeDevices(slot).filter((d) => d !== slot)];
  const seatBtn = (s: number) => {
    const t = car.seats[s],
      other = isHumanSlot(t) && t !== slot;
    return `<button data-seat="${s}" class="${s === si ? 'on' : other ? 'taken' : ''}" aria-pressed="${s === si}"${other ? ` title="${esc(slotName(t))} sits here: you swap"` : ''}>${SEAT_NAMES[s]}</button>`;
  };
  card.innerHTML = `
    <div class="who">${
      online
        ? `<b>${esc(slotName(slot))}</b>`
        : `<select class="dev" aria-label="Plays with">${devices.map((d) => `<option value="${d}"${d === slot ? ' selected' : ''}>${esc(deviceInfo(d)?.label ?? d)}</option>`).join('')}</select>`
    }</div>
    <div class="pick cars-pick" role="group" aria-label="Car">${setup.cars.map((c, i) => `<button class="sw${i === ci ? ' on' : ''}" data-car="${i}" style="--c:${requireValue(TEAMS[c.team]).ui}" aria-pressed="${i === ci}" title="${requireValue(TEAMS[c.team]).name}">${i + 1}</button>`).join('')}</div>
    <div class="pick seat-pick" role="group" aria-label="Seat">${SEAT_ORDER.map(seatBtn).join('')}</div>
    ${online ? '' : '<button class="x" title="Remove this player" aria-label="Remove this player">×</button>'}`;
  card.querySelectorAll<HTMLButtonElement>('button[data-car]').forEach((b) =>
    b.addEventListener('click', () => {
      toCar(slot, +dataValue(b, 'car'));
      renderSetup();
    }),
  );
  card.querySelectorAll<HTMLButtonElement>('button[data-seat]').forEach((b) =>
    b.addEventListener('click', () => {
      sit(slot, ci, +dataValue(b, 'seat'));
      renderSetup();
    }),
  );
  card.querySelector('select.dev')?.addEventListener('change', (e) => {
    const d = (e.target as HTMLSelectElement).value;
    if (freeDevices(slot).includes(d)) car.seats[si] = d;
    renderSetup();
  });
  card.querySelector('button.x')?.addEventListener('click', () => {
    car.seats[si] = B;
    renderSetup();
  });
  return card;
}

export function renderSetup() {
  followSetup(setup.cars); // the keys and mouse, or the touch screen: whichever was used last
  if (!isReplica()) buildMap(setup.mapSeed, setup.cars.length);
  const who = players();
  // the players, each with a car and a seat to pick; then whoever else can join on this screen
  const pl = $('#players');
  pl.replaceChildren(...who.map(playerCard));
  if (!who.length) pl.innerHTML = '<p class="nobody">No players: the CPU plays on its own and you watch.</p>';
  const free = freeDevices();
  $('#join').innerHTML =
    (free.length
      ? `<span class="label">Add a player</span>${free.map((d) => `<button class="btn small" data-dev="${d}">+ ${esc(deviceInfo(d)?.label ?? d)}</button>`).join('')}`
      : '') + '<span class="hint">Gamepads join with any button</span>';
  $('#join')
    .querySelectorAll<HTMLButtonElement>('button[data-dev]')
    .forEach((b: HTMLButtonElement) =>
      b.addEventListener('click', () => {
        addPlayer(dataValue(b, 'dev'));
        renderSetup();
      }),
    );
  // the cars: each turning next to its row, with its kit and who sits where
  const list = $('#carList');
  list.innerHTML = '';
  setup.cars.forEach((c, ci) => {
    const row = document.createElement('div');
    row.className = 'car-row';
    row.style.setProperty('--team', requireValue(TEAMS[c.team]).ui);
    row.innerHTML = `
      <div class="car-num">${ci + 1}</div>
      <canvas class="car-spin" aria-hidden="true"></canvas>
      <div class="car-look">
        <div class="team-name">${requireValue(TEAMS[c.team]).name}</div>
        <select class="kit" aria-label="Car ${ci + 1}" title="${CAR_BLURB[c.kit]}">${Object.entries(KIT_NAMES)
          .map(([k, n]) => `<option value="${k}"${k === c.kit ? ' selected' : ''}>${n}</option>`)
          .join('')}</select>
      </div>
      <div class="crew">${SEAT_ORDER.map((s) => {
        const t = c.seats[s],
          h = isHumanSlot(t);
        return `<div class="crew-seat${h ? ' human' : ''}"><span>${SEAT_NAMES[s]}</span>${h ? esc(slotName(t)) : 'CPU'}</div>`;
      }).join('')}</div>`;
    $('select.kit', row).addEventListener('change', (e) => {
      if (e.target instanceof HTMLSelectElement && isKit(e.target.value)) {
        c.kit = e.target.value;
        renderSetup();
      }
    });
    list.appendChild(row);
  });
  showCarPreviews(setup.cars, [...list.querySelectorAll<HTMLCanvasElement>('canvas.car-spin')]);
  $('#carCount').textContent = String(setup.cars.length);
  requiredElement('#fewerCars', HTMLButtonElement).disabled = setup.cars.length <= MIN_CARS;
  requiredElement('#moreCars', HTMLButtonElement).disabled = setup.cars.length >= MAX_CARS;
  requiredElement('#botSkill', HTMLSelectElement).value = String(setup.botSkill);
  requiredElement('#botSkill', HTMLSelectElement)
    .querySelectorAll('option')
    .forEach((o, i: number) => {
      if (D.bots.levels[i]) o.textContent = D.bots.levels[i].name;
    });
  // a hand-made town is the same town every round: there's no new one to lay out
  const fixed = D.rounds.map === 'town';
  $('#mapName').textContent = fixed ? D.town.id : '#' + setup.mapSeed;
  requiredElement('#newMap', HTMLButtonElement).disabled = fixed;
  // summary
  const bots = setup.cars.length * 4 - who.length;
  const notes = who
    .filter((d) => d.startsWith('pad') && deviceInfo(d) && !Input.pads[+requireValue(d[3])])
    .map((d) => `${deviceInfo(d)?.label}: press a button on it`);
  $('#summary').innerHTML =
    `<b>${who.length}</b> player${who.length === 1 ? '' : 's'} · <b>${bots}</b> CPU · <b>${setup.cars.length}</b> cars` +
    (notes.length ? `<br>${notes.join(' · ')}` : '');
  const pads = Input.pads
    .map((p, i) => (p ? `Gamepad ${i + 1}: ${p.id.slice(0, 40)}` : null))
    .filter(Boolean);
  $('#padInfo').textContent = pads.length
    ? pads.join(' · ')
    : 'No gamepads detected yet. Plug one in and press any button.';
  saveSetup();
  schedulePreview();
  if (isNetHost()) hostSetupChanged();
}

function bindMenu() {
  requiredElement('#botSkill', HTMLSelectElement).addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLSelectElement)) return;
    const v = +e.target.value;
    if ([0, 1, 2].includes(v)) {
      setup.botSkill = v;
      saveSetup();
    }
  });
  requiredElement('#newMap', HTMLButtonElement).addEventListener('click', () => {
    setup.mapSeed = newMapSeed();
    clearArena();
    renderSetup();
  });
  requiredElement('#fewerCars', HTMLButtonElement).addEventListener('click', () => {
    setCarCount(setup.cars.length - 1);
    renderSetup();
  });
  requiredElement('#moreCars', HTMLButtonElement).addEventListener('click', () => {
    setCarCount(setup.cars.length + 1);
    renderSetup();
  });
  $('#startBtn').addEventListener('click', () => {
    SFX.init();
    startGame();
  });
  $('#resumeBtn').addEventListener('click', () => {
    pauseGame(false);
    if (usesMouse()) renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  });
  $('#restartBtn').addEventListener('click', () => {
    $('#pause').classList.add('hidden');
    startRound();
  });
  $('#setupBtn').addEventListener('click', () => toMenu());
  const redraw = () =>
    setTimeout(() => {
      if (G.state === 'menu' && !isReplica()) renderSetup();
    }, 50); // (still there 50 ms on?)
  window.addEventListener('gamepadconnected', redraw);
  window.addEventListener('gamepaddisconnected', redraw);
  // Offline the game pauses when the window loses focus, or a gamepad someone plays with comes loose.
  window.addEventListener('blur', () => {
    if (!getSession()) pauseGame(true);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    const dev = 'pad' + e.gamepad.index;
    if (!getSession() && G.humans.some((h) => h.device === dev))
      pauseGame(true, `${deviceInfo(dev)?.label ?? 'A gamepad'} came loose: plug it back in, then resume.`);
  });
}

// =====================================================================
//  Rounds
// =====================================================================
export function clearArena() {
  for (const c of G.cars) disposeCar(c);
  clearDebris();
  for (const h of G.humans) if (h.cam) scene.remove(h.cam);
  G.cars = [];
  G.bullets = [];
  G.humans = [];
  G.remotes = [];
  GLOW.clear();
  SMOKE.clear();
  clearSkids();
  clearPaint();
  clearDrops();
  clearConfetti();
  resetBreakables();
  SFX.stopEngines();
  $('#hud').innerHTML = '';
  $('#feed').innerHTML = '';
  G.spec = null;
}

function placeCars(cfgCars: CarSetup[]) {
  const order = cfgCars
    .map((_c, i: number) => i)
    .sort((a, b) => requireValue(cfgCars[a]).team - requireValue(cfgCars[b]).team || a - b);
  // the town's own start slots, shuffled; any more cars anywhere on the tarmac, well apart, facing the middle
  const own = (TOWN?.spawns ?? []).map((s) => ({ ...s }));
  for (let i = own.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [own[i], own[j]] = [requireValue(own[j]), requireValue(own[i])];
  }
  const mine = own.slice(0, cfgCars.length),
    slots = [...mine, ...randomSpawns(cfgCars.length - mine.length, mine)];
  const cars = cfgCars.map((cfg, i: number) => createCar(i, cfg));
  order.forEach((ci, k) => {
    const car = requireValue(cars[ci]),
      s = requireValue(slots[k]);
    car.pos.set(s.x, 0, s.z);
    car.yaw = s.yaw;
    for (const seat of GUN_SEATS) {
      gunAt(car, seat).yaw = defaultGunYaw(car, seat);
      gunAt(car, seat).pitch = 0.02;
    }
  });
  return cars;
}

export function makeHuman(id: number, device: string, car: Car, seat: number): LocalHuman {
  const cam = new THREE.PerspectiveCamera(72, 1, 0.05, 4500);
  cam.layers.set(0); // (layers: see car.ts setLayer)
  for (let j = 0; j < 8; j++) if (j !== id) cam.layers.enable(9 + j);
  for (let c = 0; c < 8; c++) if (c !== car.idx) cam.layers.enable(17 + c);
  scene.add(cam);
  return {
    ...participantState(id, device, car, seat),
    remote: false,
    cam,
    camMode: 'cockpit',
    camYaw: car.yaw,
    camY: 0,
    orbit: 0,
    orbitYaw: 0,
    orbitIdle: 9,
    shake: 0,
    dmgFlash: 0,
    hitMark: 0,
    killMark: 0,
    dead: false,
    watch: null,
    watchT: 0,
    vp: { x: 0, y: 0, w: 1, h: 1 },
    hud: null,
    hintT: 9,
  };
}

// A player on another screen, in a seat of this (the host's) game: their controls come over the network.
export function makeRemote(peer: number, car: Car, seat: number): RemoteHuman {
  return {
    ...participantState(-1, 'remote', car, seat),
    remote: true,
    peer,
    peerIndex: 0,
    ...nameOf(peer, 0),
    device: 'remote',
    car,
    seat,
    dead: false,
    frame: null,
    frameAt: 0,
  };
}

// Online a player is known by what the hub calls their screen's seat (Player Three, Player Three B…); offline as Player One, Player Two…
function nameLocalPlayers() {
  G.humans.forEach((h, i) => Object.assign(h, nameOf(mySeat(), i)));
}

// keepScore: a new host carries on the match it took over. from: the setup to play (the saved one, unless ?autostart)
export function startGame(keepScore = false, from = setup) {
  G.cfg = { botSkill: from.botSkill | 0, mapSeed: from.mapSeed, cars: JSON.parse(JSON.stringify(from.cars)) };
  buildMap(from.mapSeed, from.cars.length);
  if (!keepScore) {
    resetCompetition();
    G.teamScores.fill(0);
    G.points.fill(0);
    G.round = 0;
  }
  $('#menu').classList.add('hidden');
  stopCarPreviews();
  (document.activeElement as HTMLElement | null)?.blur?.();
  startRound();
}

export function startRound() {
  clearArena();
  // a newer revision of the data that landed during the last round is played from this one on
  takeRevision();
  buildMap(G.cfg.mapSeed, G.cfg.cars.length);
  G.round++;
  G.cars = placeCars(G.cfg.cars);
  let hid = 0;
  for (const car of G.cars) {
    car.cfg.seats.forEach((slot, s) => {
      const peer = peerOfSlot(slot);
      if (peer) {
        // a player on another screen, if they're still here
        if (peerSeats().includes(peer)) {
          const h = makeRemote(peer, car, s);
          G.remotes.push(h);
          car.occ[s] = { kind: 'human', h };
        } else car.occ[s] = makeBot(car, s);
      } else if (isHumanSlot(slot)) {
        const h = makeHuman(hid++, slot, car, s);
        G.humans.push(h);
        car.occ[s] = { kind: 'human', h };
      } else if (slot === B) car.occ[s] = makeBot(car, s);
    });
  }
  nameLocalPlayers();
  for (const car of G.cars) {
    updatePlayerTag(car);
    refreshOccupantVisuals(car);
  }
  buildHud();
  G.state = 'countdown';
  G.countdown = D.rounds.countdown;
  G.time = 0;
  beginCompetition();
  G.lastCount = 4;
  $('#pause').classList.add('hidden');
  G.menuOpen = false;
  if (isNetHost()) hostRoundStarted();
}

function updateFlow(dt: number) {
  if (G.state === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown - 0.5);
    if (n !== G.lastCount && n >= 1 && n <= 3) {
      G.lastCount = n;
      SFX.count(false);
    }
    setCenter(G.countdown > 0.5 ? `${Math.max(1, n)}<small>Round ${G.round}</small>` : '');
    if (G.countdown <= 0.5) {
      G.state = 'playing';
      G.goT = 1;
      SFX.count(true);
    }
  } else if (G.state === 'playing') {
    G.goT = (G.goT || 0) - dt;
    setCenter(G.goT > 0 ? 'GO!' : '');
  } else if (G.state === 'over') {
    G.overTimer -= dt;
    const w = G.winnerTeam;
    const title =
      w >= 0
        ? `<span style="color:${requireValue(TEAMS[w]).ui}">${requireValue(TEAMS[w]).name.toUpperCase()} WINS</span>`
        : 'DRAW';
    setCenter(
      `${title}<small>${standings()}</small><small>Next round in ${Math.max(0, Math.ceil(G.overTimer))} · ${G.humans.some((h) => h.device === 'touch') ? '❚❚' : 'Esc'} for menu</small>`,
    );
    if (G.overTimer <= 0) startRound();
  }
}

// points so far, best first
export function standings() {
  return [...new Set(G.cars.map((c) => c.team))]
    .sort((a, b) => requireValue(G.points[b]) - requireValue(G.points[a]))
    .map(
      (t) =>
        `<span style="color:${requireValue(TEAMS[t]).ui}">${requireValue(TEAMS[t]).name} ${Math.round(requireValue(G.points[t]))}</span>`,
    )
    .join(' · ');
}

// note: why it paused, on the pause screen (a gamepad that came loose, say)
export function pauseGame(on: boolean, note = '') {
  if (on && note) $('#pauseNote').textContent = note;
  if (!on) $('#pauseNote').textContent = '';
  if (getSession()) {
    // online the game goes on for everyone else: this only opens the menu (and leaves the controls alone)
    if (on && !['playing', 'countdown', 'over'].includes(G.state)) return;
    G.menuOpen = on;
    $('#pause').classList.toggle('hidden', !on);
    if (on && document.pointerLockElement) document.exitPointerLock();
    return;
  }
  if (on) {
    if (!['playing', 'countdown', 'over'].includes(G.state)) return;
    G.prevState = G.state;
    G.state = 'paused';
    $('#pause').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    SFX.stopEngines();
  } else if (G.state === 'paused') {
    G.state = G.prevState || 'playing';
    $('#pause').classList.add('hidden');
  }
}

export function toMenu() {
  clearArena();
  G.state = 'menu';
  G.menuOpen = false;
  $('#pause').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  setCenter('');
  setHtml($('#scores'), '');
  if (document.pointerLockElement) document.exitPointerLock();
  renderSetup();
}

// Parked cars behind the start screen, matching the current setup.
let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewSetup, 120);
}
function previewSetup() {
  if (G.state !== 'menu' || !TPL) return;
  clearArena();
  G.cars = placeCars(setup.cars);
  for (const car of G.cars) {
    car.cfg.seats.forEach((_slot, s) => {
      car.occ[s] = makeBot(car, s);
    });
    for (const s of GUN_SEATS) {
      gunAt(car, s).yaw = defaultGunYaw(car, s) + (s === 1 ? 0.5 : -0.4);
      gunAt(car, s).pitch = 0.12;
    }
    refreshOccupantVisuals(car);
    syncCarVisual(car, 1);
  }
}

// =====================================================================
//  Per-frame car effects: skids, smoke, fire, boost flames
// =====================================================================
export function carFx(car: Car, dt: number) {
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  const vF = car.vel.x * sy + car.vel.z * cy,
    vL = car.vel.x * cy - car.vel.z * sy;
  const sp = Math.hypot(car.vel.x, car.vel.z);
  const burning = car.burn && car.burn.on && sp > 0.8; // a burn always leaves rubber, donuts too
  const sliding =
    car.grounded &&
    (burning ||
      (sp > 3 && (Math.abs(vL) > 3 || (car.ctrl.handbrake && sp > 5) || (car.ctrl.throttle < 0 && vF > 8))));
  car.skidPrev = car.skidPrev || [null, null];
  for (let i = 0; i < 2; i++) {
    const w = requireValue(CARDIM.wheels[2 + i]);
    const p = carToWorld(car, w[0], 0, w[1], new THREE.Vector3());
    if (sliding) {
      const q = car.skidPrev[i];
      if (!q) car.skidPrev[i] = p;
      else if (Math.hypot(p.x - q.x, p.z - q.z) > 0.06) {
        // slow slides (donuts) lay rubber too: wait until the wheel has moved a bit
        addSkid(q.x, q.z, p.x, p.z, 0.24);
        car.skidPrev[i] = p;
      }
      if (Math.random() < dt * 14)
        SMOKE.emit({
          x: p.x,
          y: car.pos.y + 0.2,
          z: p.z,
          vx: rand(-0.5, 0.5),
          vy: rand(0.3, 1),
          vz: rand(-0.5, 0.5),
          life: rand(0.8, 1.4),
          s0: 0.5,
          s1: 2.2,
          c0: [0.75, 0.7, 0.65, 0.32],
          c1: [0.8, 0.76, 0.7, 0],
          drag: 1.5,
        });
    } else car.skidPrev[i] = null;
  }
  car.smokeT -= dt;
  if (car.smokeT <= 0) {
    const hood = carToWorld(car, 0, 1.0, 1.7, _v1),
      s = car.sys;
    if (!car.alive) {
      car.smokeT = 1; // out cars don't burn
    } else {
      car.smokeT = s.fire ? 0.05 : s.engine < 30 ? 0.07 : 0.15;
      // a fire licks out of the engine bay (and spreads along the car as it grows)
      for (let i = 0; i < s.fire; i++) {
        const p = carToWorld(car, rand(-0.5, 0.5), 1.0, 1.7 - i * 1.3, _v2);
        fireLick(p.x, p.y, p.z, 0.8 + i * 0.2);
      }
      if (s.fire && Math.random() < 0.5) smokePuff(hood.x, hood.y + 0.5, hood.z, true, 1);
      else if (s.engine < 65) smokePuff(hood.x, hood.y, hood.z, s.engine < 30, 0.8);
      if (s.leak) {
        const p = carToWorld(car, rand(-0.3, 0.3), 0.3, -1.9, _v2);
        SMOKE.emit({
          x: p.x,
          y: p.y,
          z: p.z,
          vy: -1,
          life: 0.5,
          s0: 0.12,
          s1: 0.05,
          c0: [0.25, 0.2, 0.08, 0.9],
          c1: [0.2, 0.15, 0.05, 0],
          grav: 9,
        });
      }
    }
  }
  // driving on a rim throws sparks
  if (car.alive && sp > 4)
    for (let i = 0; i < 4; i++) {
      if (car.sys.tires[i] || Math.random() > dt * 18) continue;
      const w = requireValue(CARDIM.wheels[i]),
        p = carToWorld(car, w[0], 0.05, w[1], _v2);
      GLOW.emit({
        x: p.x,
        y: p.y,
        z: p.z,
        vx: -sy * sp * 0.4 + rand(-1, 1),
        vy: rand(1, 3),
        vz: -cy * sp * 0.4 + rand(-1, 1),
        life: 0.3,
        s0: 0.12,
        s1: 0.03,
        c0: [1, 0.85, 0.45, 1],
        c1: [1, 0.35, 0.05, 0.6],
        grav: 12,
      });
    }
  nitroFlame(car, dt); // the nitro flame out of the exhaust
}

// =====================================================================
//  Main loop
// =====================================================================
let lastT = performance.now(),
  acc = 0;
function tick(dt: number, draw = true) {
  if (isReplica()) {
    replicaTick(dt, draw);
    return;
  }
  hostTickBegin();
  const running = G.state === 'countdown' || G.state === 'playing' || G.state === 'over';
  if (running) {
    G.time += dt;
    for (const h of G.humans) updateHumanControls(h, dt);
    for (const h of G.remotes) driveRemote(h, dt);
    for (const car of G.cars) {
      for (let s = 0; s < 4; s++) {
        const o = car.occ[s];
        if (o && o.kind === 'bot' && o.bot) (s === 0 ? botDrive : s === 3 ? botMechanic : botGun)(o.bot, dt);
      }
      updateSystems(car, dt, (target, amount) => damageCar(target, amount, null, 'fire'));
      if (G.state === 'countdown') Object.assign(car.ctrl, { throttle: 0, handbrake: true, boost: false });
    }
    acc = Math.min(acc + dt, 0.1);
    while (acc >= STEP) {
      physicsStep(STEP);
      for (const car of G.cars) for (const s of GUN_SEATS) updateGun(car, s, STEP);
      updateBullets(STEP);
      acc -= STEP;
    }
    for (const car of G.cars) {
      carFx(car, dt);
      updateBurn(car, dt);
    }
    updateCompetition(dt);
    if (G.state === 'over') finishCompetition();
    updateFlow(dt);
    const local = new Set(G.humans.filter((h) => !h.dead).map((h) => h.car));
    for (const car of G.cars) SFX.engine(car, local.has(car) && car.alive);
  }
  if (G.state !== 'paused') {
    for (const car of G.cars) updateRadar(car, dt);
    updateDebris(dt);
    updateBreakables(dt);
    updateConfetti(dt);
    updateDrops(dt);
    updatePaint(dt, running);
    GLOW.update(dt);
    SMOKE.update(dt);
  }
  hostTickEnd(dt);
  if (!draw) return;
  for (const car of G.cars) syncCarVisual(car, dt);
  for (const h of G.humans) updateCamera(h, dt);
  updateAimPoints();
  drawBalls();
  render(dt);
  updateHud(dt);
  updateScores();
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  pollPads();
  const escKey = Input.pressed.has('Escape') && performance.now() - (G.lockLostAt || 0) > 400;
  if (escKey || Input.pads.some((p, i) => p && p.buttons[9] && !(Input.padPrev[i] || [])[9])) {
    if (G.state === 'paused' || G.menuOpen) pauseGame(false);
    else if (G.state === 'over' && !isReplica()) toMenu();
    else pauseGame(true);
  }
  if (G.state === 'menu' && !isReplica()) padJoin();
  adaptQuality(dt, G.state === 'playing');
  try {
    tick(dt);
  } finally {
    endInputFrame();
  } // (if a frame ever throws, keys don't keep repeating)
}

// A hidden tab gets no animation frames, and its timers slow to one a second. Online the host's game
// is everyone's, so while its tab is hidden a worker's clock keeps it going (without drawing).
let hiddenClock: Worker | null = null,
  hiddenLast = 0;
function keepRunningHidden(on: boolean): void {
  if (on === !!hiddenClock) return;
  if (!on) {
    hiddenClock?.terminate();
    hiddenClock = null;
    return;
  }
  const url = URL.createObjectURL(
    new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }),
  );
  hiddenClock = new Worker(url);
  URL.revokeObjectURL(url);
  hiddenLast = performance.now();
  hiddenClock.onmessage = () => {
    const now = performance.now(),
      dt = Math.min(0.05, Math.max(0, (now - hiddenLast) / 1000));
    hiddenLast = now;
    tick(dt, false);
    endInputFrame();
  };
}
/** Starts or stops that clock: when the tab hides or shows, and when this screen becomes host or stops being it. */
export const checkHiddenClock = (): void => keepRunningHidden(document.hidden && isNetHost());
// Leaving the tab: offline the game pauses, and the engines go quiet everywhere.
document.addEventListener('visibilitychange', () => {
  checkHiddenClock();
  if (!document.hidden) return;
  SFX.stopEngines();
  if (!getSession()) pauseGame(true);
});

// =====================================================================
//  Boot
// =====================================================================
export async function boot(): Promise<void> {
  const q = new URLSearchParams(location.search);
  setup = loadSetup() || defaultSetup();
  const qmap = Number(q.get('map')); // ?map=123 picks a map (1 to 99999)
  if (isMapSeed(qmap)) setup.mapSeed = qmap;
  buildMap(setup.mapSeed, setup.cars.length);
  try {
    setTPL(await loadCarTemplate());
  } catch (err) {
    console.warn('The car model could not be loaded, using a stand-in car.', err);
    setTPL(buildFallbackTemplate());
  }
  if (q.has('debug')) exposeForTinkering(); // ?debug: window.derby, for the console and the tests
  bindMenu();
  await startNet(); // on a zirbel host: online, as the room's host or as one of the other screens
  $('#loading').classList.add('hidden');
  if (isReplica()) {
    /* the host's setup shows until its round starts */
  } else if (q.has('autostart')) {
    G.state = 'menu';
    startGame(false, { ...defaultSetup(), mapSeed: setup.mapSeed });
  } // (the saved setup stays as it is)
  else toMenu();
  requestAnimationFrame((t) => {
    lastT = t;
    frame(t);
  });
}

// Handy for tinkering in the console: window.derby.G, window.derby.setup … (only with ?debug)
function exposeForTinkering(): void {
  window.derby = debugHandle();
}
export type DerbyDebug = ReturnType<typeof debugHandle> & {
  debugCam?: { pos: [number, number, number]; look: [number, number, number] };
};
function debugHandle() {
  return {
    G,
    get setup() {
      return setup;
    },
    set setup(s: Setup) {
      setup = s;
    },
    startGame,
    startRound,
    toMenu,
    tick,
    defaultSetup,
    switchSeat,
    damageCar,
    hitCar,
    Input,
    THREE,
    OBSTACLES,
    confettiBurst,
    damageRadar,
    breakTire,
    breakAxle,
    startFire,
    tearOffBumper,
    settleBumper,
    crackWindshield,
    crackGlassAt,
    dentCar,
    loseWheel,
    mechTasks,
    GAMES,
    TASK_GAME,
    paintHitCar,
    paintBurst,
    spawnDrop,
    giveDrop,
    get skidCount() {
      return skid.used;
    },
    get net() {
      return { role: currentRole(), seat: mySeat(), ...hostDebug(), ...replicaDebug() };
    },
    get town() {
      return TOWN;
    },
    get arenaRoot() {
      return ARENA_ROOT;
    },
    generateLayout,
    townFor,
    buildArena,
    get nav() {
      return NAV;
    },
    get obstacles() {
      return OBSTACLES;
    },
    get data() {
      return D;
    },
    get rev() {
      return dataRevision();
    },
    get mem() {
      return { ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 };
    },
    // route network check for tinkering: nodes that sit in something, and how connected each one is
    navInfo() {
      if (!NAV) return null;
      return NAV.nodes.map(([x, z], i: number) => ({
        i,
        x,
        z,
        edge: +arenaSDF(x, z).toFixed(1),
        blocked: !segmentClear(x, z, x + 0.01, z, 0.5),
        links: requireValue(NAV.D[i]).filter(
          (d: number, j: number) => j !== i && isFinite(d) && requireValue(NAV.next[i])[j] === j,
        ).length,
        reach: requireValue(NAV.D[i]).filter(isFinite).length,
      }));
    },
    // fast-forward the simulation without drawing (used for testing/balancing)
    simulate(seconds: number, dt = 1 / 60) {
      for (let t = 0; t < seconds; t += dt) tick(dt, false);
    },
  };
}
