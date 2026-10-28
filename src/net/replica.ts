import { requireValue } from '../required-fields.ts';
import { isDropKind } from '../gameplay/supplies.ts';
import { receiveRoomMusic } from './music-room.ts';
import { acceptCompetitionSummary, resetCompetition } from '../competition.ts';
import { gunAt } from '../gameplay/guns.ts';
import { localDevice } from '../local-device.ts';
import { ask, sendPour } from './commands.ts';
import { participantState, resetSeatState } from '../gameplay/participants.ts';
import type * as ZN from '/zirbel-net.js';
import { GUN_SEATS, MAX_HP, TEAMS, TURRETS, clamp, damp, setPaintDamage, wrapPi } from '../core.ts';
import { createCar, refreshOccupantVisuals, syncCarVisual, updatePlayerTag } from '../car.ts';
import { G } from '../state.ts';
import { resetBreakables, setDown, updateBreakables } from '../breakables.ts';
import { GLOW, SMOKE, updateConfetti, updateDebris } from '../fx.ts';
import { SFX } from '../audio.ts';
import { drawBalls, updatePaint } from '../paint.ts';
import { updateRadar } from '../radar.ts';
import { updateDrops } from '../drops.ts';
import { updateBullets } from '../combat.ts';
import { clampGunToArc, cycleWatch, defaultGunYaw, readControls } from '../control.ts';
import { Input } from '../gameplay/input.ts';
import { placeDrop } from '../drops.ts';
import {} from '../drop-data.ts';
import { GAMES, updateHumanMechanic } from '../mechanic.ts';
import {
  buildHud,
  render,
  setCenter,
  updateAimPoints,
  updateCamera,
  updateHud,
  updateScores,
} from '../views.ts';
import { lifecycle } from '../lifecycle.ts';
import { applyDetail } from './detail.ts';
import { replayEffects } from './effects.ts';
import {
  CONTROLS_PER_SECOND,
  DRAW_DELAY_MS,
  MSG,
  PROTOCOL,
  asInt,
  asNumber,
  asObject,
  asSeatTaker,
  parseJson,
} from './protocol.ts';
import {
  readSnapshot,
  writeControls,
  NO_CONTROLS,
  type CarSnap,
  type Controls,
  type Snapshot,
} from './snapshot.ts';
import { getSession, mySeat, nameOf } from './context.ts';
import { nextDevice, useDevice } from '../touch.ts';
import { D, useLoaded, useRevision } from '../data.ts';
import type { LocalHuman as Human } from '../human-types.ts';
import type { Car } from '../car.ts';
import { newBurn } from '../gameplay/scoring.ts';
import { lastSetup, setLastSetup } from './context.ts';
/**
 * The replica's side: this screen draws the host's game. It builds the host's round (the same map,
 * the same cars), moves the cars between the host's snapshots, applies each car's detail and the
 * effects, and sends its own players' controls. Nothing here decides anything: damage, points, the
 * bots and the round are the host's. Its own gunners' turrets move at once (the host follows), and
 * its mechanics' jobs are played here and handed to the host when done.
 */

const HOST = 255; // zirbel-net's HOST
let interp: ZN.Interp<Snapshot> | null = null;
let ctrlClock = 0;
let timer = 0,
  lastCount = 4,
  goT = 0,
  prevState = '';
const seen = { snaps: 0, bad: 0, fx: 0, details: 0, last: 0 };
/** What this screen has heard from the host, for tests and the console (derby.net). */
export const replicaDebug = () => ({ ...seen, buffered: interp ? 1 : 0, now: getSession()?.net.now() ?? 0 });
/** The host's setup, as last heard: shown while waiting, and used if this screen has to take over. */

/** The controls this screen plays with: the first gamepad that's plugged in, else the touch screen or keys and mouse. */
/** The last device used wins (touch.ts): the keys and mouse, the touch screen, a gamepad. One that goes away hands back. */
function followDevice(h: Human): void {
  let next = nextDevice(h);
  if (next.startsWith('pad') && !Input.pads[+requireValue(next[3])]) next = localDevice();
  if (next !== h.device) useDevice(h, next);
}

/** The most a host's message of each kind can sensibly be; anything bigger is dropped unread. */
const MAX_BYTES: Readonly<Record<number, number>> = {
  [MSG.radio]: 8192,
  [MSG.hello]: 16384,
  [MSG.setup]: 16384,
  [MSG.round]: 65536,
  [MSG.crew]: 4096,
  [MSG.flow]: 65536,
  [MSG.detail]: 4096,
  [MSG.fx]: 16384,
  [MSG.snap]: 4096,
};
/** Snapshots stamped further than this from the hub's clock are not the host's real ones. */
const SNAP_SKEW_MS = 5000;
/** A host that speaks another version is ignored until it says hello in this one. */
let hostOk = true;
/** Rounds and maps cost a rebuild: at most one a second, the newest winning. */
const REBUILD_MS = 1000;
let builtAt = -1e9,
  laterRound: Record<string, unknown> | null = null,
  laterMap: [number, number] | null = null,
  laterTimer = 0;
/** How many cars a setup or round has: the town is sized for them, so every screen must agree. */
const carCount = (v: unknown): number => (Array.isArray(v) ? Math.min(8, Math.max(2, v.length)) : 4);
let lastCrewText = '';
const tagNames = new WeakMap<Car, string>();
/**
 * A round is built with the data its round message names. While that revision is read, what the host
 * sends for the round waits here (its snapshots don't: newer ones come), and is played once it's built.
 */
let roundGen = 0,
  readingRev = false;
const held: { type: number; bytes: Uint8Array }[] = [];
const revOf = (o: Record<string, unknown>): string =>
  typeof o['rev'] === 'string' ? o['rev'].slice(0, 64) : '';

export function replicaStart(): void {
  interp = null;
  setLastSetup(null);
  hostOk = true;
  lastCrewText = '';
  lifecycle().clearArena();
  G.state = 'menu';
  showWaiting();
  replicaResync();
}

/** Asks the host for everything: a page that reloaded keeps its seat, so the host doesn't hear it join. */
export function replicaResync(): void {
  getSession()?.net.send(HOST, MSG.ask, JSON.stringify({ a: 'sync' }));
}

/** This screen stops drawing the host's game: it is the host now, or offline. What was heard is kept for a takeover. */
export function replicaStop(): void {
  interp = null;
  clearTimeout(laterTimer);
  laterTimer = 0;
  laterRound = null;
  roundGen++;
  readingRev = false;
  held.length = 0;
  hideWaiting();
}

export function replicaLinkDown(): void {
  // keep drawing what we have; the host's game goes on without this screen's controls for a moment
}

// ---- messages from the host ----

export function replicaMessage(type: number, r: ZN.Reader): void {
  if (r.left() > (MAX_BYTES[type] ?? 0)) return;
  if (!hostOk && type !== MSG.hello) return;
  if (readingRev && type !== MSG.round && type !== MSG.hello && type !== MSG.setup) {
    if (type !== MSG.snap && held.length < 512) held.push({ type, bytes: r.rest().slice() });
    return;
  }
  switch (type) {
    case MSG.radio:
      receiveRoomMusic(parseJson(r.text()));
      return;
    case MSG.snap: {
      const s = readSnapshot(r);
      const z = getSession();
      if (!s || !z || !Number.isFinite(s.time) || Math.abs(s.time - z.net.now()) > SNAP_SKEW_MS) {
        seen.bad++;
        return;
      }
      seen.snaps++;
      seen.last = s.time;
      (interp ??= new z.zn.Interp<Snapshot>(32)).push(s.time, s);
      return;
    }
    case MSG.fx:
      seen.fx++;
      replayEffects(r);
      return;
    case MSG.detail: {
      const d = asObject(parseJson(r.text()));
      seen.details++;
      const car = G.cars[asInt(d['i'], 0, 255, 255)];
      if (car) applyDetail(car, d);
      return;
    }
    case MSG.crew: {
      const text = r.text();
      if (text === lastCrewText) return; // nothing changed
      lastCrewText = text;
      applyCrew(parseJson(text));
      return;
    }
    case MSG.flow:
      applyFlow(asObject(parseJson(r.text())));
      return;
    case MSG.round:
      scheduleRound(asObject(parseJson(r.text())));
      return;
    case MSG.hello:
    case MSG.setup: {
      const o = asObject(parseJson(r.text()));
      if (type === MSG.hello) {
        hostOk = asInt(o['protocol'], 0, 999, 0) === PROTOCOL;
        if (!hostOk) {
          setWaiting('This host runs another version of derby01. Reload both.');
          return;
        }
      }
      setLastSetup(type === MSG.hello ? asObject(o['setup']) : o);
      // a host that started over (it reloaded, say) is back at its setup: so is this screen
      if (type === MSG.hello && o['state'] === 'menu' && G.state !== 'menu') {
        lifecycle().clearArena();
        G.state = 'menu';
        setCenter('');
        roundGen++;
        readingRev = false;
        held.length = 0;
      }
      if (G.state === 'menu') {
        const seed = asInt(lastSetup?.['mapSeed'], 1, 99999, 1),
          cars = carCount(lastSetup?.['cars']),
          z = getSession();
        // the town behind the setup is drawn with the host's data, once it's read
        if (type === MSG.hello && z && !useLoaded(revOf(o)))
          void useRevision(z.net, revOf(o)).then(() => {
            if (G.state === 'menu') scheduleMap(seed, cars);
          });
        else scheduleMap(seed, cars);
        showWaiting();
      }
      return;
    }
  }
}

/** The newest round or map waits until a rebuild is allowed again. */
function scheduleRound(info: Record<string, unknown>): void {
  laterRound = info;
  rebuildSoon();
}
function scheduleMap(seed: number, cars: number): void {
  laterMap = [seed, cars];
  rebuildSoon();
}
function rebuildSoon(): void {
  if (laterTimer) return;
  const run = (): void => {
    laterTimer = 0;
    builtAt = performance.now();
    const round = laterRound,
      map = laterMap;
    laterRound = null;
    laterMap = null;
    if (round) buildRoundWithData(round);
    else if (map && G.state === 'menu') lifecycle().buildMap(map[0], map[1]);
  };
  const wait = builtAt + REBUILD_MS - performance.now();
  if (wait <= 0) run();
  else laterTimer = setTimeout(run, wait) as unknown as number;
}

// The round's data first: at hand already (read when the revision landed), or read now while its messages wait.
function buildRoundWithData(info: Record<string, unknown>): void {
  const gen = ++roundGen,
    rev = revOf(info),
    z = getSession();
  readingRev = false;
  held.length = 0;
  if (useLoaded(rev) || !z) {
    buildRound(info);
    return;
  }
  readingRev = true;
  setWaiting("Loading the round's data…");
  void useRevision(z.net, rev).then((ok) => {
    if (gen !== roundGen) return; // a newer round came meanwhile
    if (!ok)
      console.warn(
        `derby01: playing round ${String(info['round'])} without revision ${rev}: it couldn't be read`,
      );
    readingRev = false;
    buildRound(info);
    for (const m of held.splice(0)) replicaMessage(m.type, new z.zn.Reader(m.bytes));
  });
}

function buildRound(info: Record<string, unknown>): void {
  lifecycle().clearArena();
  lifecycle().buildMap(asInt(info['mapSeed'], 1, 99999, 1), carCount(info['cars'])); // the town is sized for the round's cars
  resetBreakables();
  for (const e of Array.isArray(info['down']) ? info['down'].slice(0, 4096) : []) {
    const [i, dx, dz] = Array.isArray(e) ? e : [];
    const x = asNumber(dx, -1, 1, 1),
      z = asNumber(dz, -1, 1, 0),
      l = Math.hypot(x, z) || 1;
    setDown(asInt(i, 0, 65535, -1), x / l, z / l);
  }
  G.round = asInt(info['round'], 0, 1e6, 1);
  if (G.round === 1) resetCompetition();
  const cars = (Array.isArray(info['cars']) ? info['cars'] : []).slice(0, 8).map(asObject);
  G.cfg = {
    botSkill: asInt(info['botSkill'], 0, 2, 1),
    mapSeed: asInt(info['mapSeed'], 1, 99999, 1),
    cars: cars.map((c) => ({
      team: asInt(c['team'], 0, TEAMS.length - 1, 0),
      kit: typeof c['kit'] === 'string' ? c['kit'] : 'stock',
      seats: ['bot', 'bot', 'bot', 'bot'],
    })),
  };
  G.cars = G.cfg.cars.map((cfg, i: number) => {
    const car = createCar(i, cfg),
      c = cars[i]!;
    car.pos.set(asNumber(c['x'], -400, 400, 0), 0, asNumber(c['z'], -400, 400, 0));
    car.yaw = asNumber(c['yaw'], -10, 10, 0);
    for (const s of GUN_SEATS) {
      gunAt(car, s).yaw = defaultGunYaw(car, s);
      gunAt(car, s).pitch = 0.02;
    }
    return car;
  });
  // supply drops already on the map, landed
  for (const e of Array.isArray(info['drops']) ? info['drops'].slice(0, 12) : []) {
    const [id, type, x, z] = Array.isArray(e) ? e : [];
    if (Number.isInteger(id) && isDropKind(type))
      placeDrop(id, type, asNumber(x, -400, 400, 0), asNumber(z, -400, 400, 0), 0);
  }
  G.state = 'countdown';
  G.time = 0;
  timer = D.rounds.countdown;
  interp = null;
  hideWaiting();
  lastCrewText = '';
  applyCrew(info['crew']);
}

const nextLocalId = (): number => G.humans.reduce((m: number, h: Human) => Math.max(m, h.id + 1), 0);

/** Who sits where: this screen's own players get views, the others are crew in the cars. */
function applyCrew(raw: unknown): void {
  const rows = Array.isArray(raw) ? raw : [];
  const me = mySeat();
  const seen = new Set<Human>();
  let rebuilt = false;
  G.cars.forEach((car: Car, ci: number) => {
    const row = Array.isArray(rows[ci]) ? rows[ci] : [];
    for (let si = 0; si < 4; si++) {
      const t = asSeatTaker(row[si]);
      if (t === 'empty') {
        car.occ[si] = null;
        continue;
      }
      if (t === 'bot') {
        car.occ[si] = { kind: 'bot' };
        continue;
      }
      if (t.p !== me) {
        car.occ[si] = {
          kind: 'human',
          h: {
            ...participantState(-1, 'remote', car, si),
            remote: true,
            peer: t.p,
            peerIndex: t.i,
            frame: null,
            frameAt: 0,
            ...nameOf(t.p, t.i),
          },
        };
        continue;
      }
      let h = G.humans.find((x: Human) => x.localIndex === t.i);
      if (!h) {
        h = lifecycle().makeHuman(nextLocalId(), localDevice(), car, si);
        h.localIndex = t.i;
        G.humans.push(h);
        rebuilt = true;
      }
      Object.assign(h, nameOf(me, t.i));
      if (h.car !== car || h.seat !== si) {
        resetSeatState(h, car, si);
      }
      car.occ[si] = { kind: 'human', h };
      seen.add(h);
    }
  });
  // players of this screen who lost their seat watch
  const before = G.humans.length;
  G.humans = G.humans.filter((h: Human) => seen.has(h));
  if (rebuilt || G.humans.length !== before) buildHud();
  for (const car of G.cars) {
    refreshOccupantVisuals(car);
    // the name tag is a canvas: redrawn only when the names on it change
    const names = car.occ.map((o) => (o && o.kind === 'human' ? o.h.tag : '')).join(' ');
    if (tagNames.get(car) !== names) {
      tagNames.set(car, names);
      updatePlayerTag(car);
    }
  }
}

function applyFlow(o: Record<string, unknown>): void {
  const pts = Array.isArray(o['points']) ? o['points'] : [],
    wins = Array.isArray(o['teamScores']) ? o['teamScores'] : [];
  for (let t = 0; t < TEAMS.length; t++) {
    G.points[t] = asNumber(pts[t], 0, 1e7, 0);
    G.teamScores[t] = asInt(wins[t], 0, 1e4, 0);
  }
  G.round = asInt(o['round'], 0, 1e6, G.round);
  acceptCompetitionSummary(o['summary']);
  G.winnerTeam = asInt(o['winnerTeam'], -1, TEAMS.length - 1, -1);
  if (o['state'] === 'menu' && G.state !== 'menu') {
    lifecycle().clearArena();
    G.state = 'menu';
    setCenter('');
    showWaiting();
  }
}

// ---- every frame ----

const lerpA = (a: number, b: number, t: number): number =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function applySnapshots(): void {
  const z = getSession();
  if (!interp || !z) return;
  const s = interp.sample(z.net.now() - DRAW_DELAY_MS);
  if (!s) return;
  const { a, b, t } = s;
  timer = b.timer;
  if (b.state !== 'menu' && b.state !== 'paused') G.state = b.state;
  G.cars.forEach((car: Car, i: number) => {
    const ca: CarSnap | undefined = a.cars[i],
      cb: CarSnap | undefined = b.cars[i];
    if (!ca || !cb) return;
    car.pos.set(mix(ca.x, cb.x, t), mix(ca.y, cb.y, t), mix(ca.z, cb.z, t));
    car.yaw = lerpA(ca.yaw, cb.yaw, t);
    car.vel.set(mix(ca.vx, cb.vx, t), mix(ca.vy, cb.vy, t), mix(ca.vz, cb.vz, t));
    car.yawRate = mix(ca.yawRate, cb.yawRate, t);
    car.steer = mix(ca.steer, cb.steer, t);
    car.lean.p = mix(ca.leanP, cb.leanP, t);
    car.lean.r = mix(ca.leanR, cb.leanR, t);
    car.land = mix(ca.land, cb.land, t);
    car.grounded = cb.grounded;
    car.boosting = cb.boosting;
    car.boostFuel = cb.boostFuel;
    car.ctrl.throttle = cb.throttle;
    car.ctrl.handbrake = cb.handbrake;
    car.burn = { ...(car.burn || newBurn()), on: cb.burnOn, t: cb.burnT };
    if (cb.hp < car.hp)
      for (const h of G.humans)
        if (h.car === car) h.dmgFlash = Math.min(1, h.dmgFlash + (car.hp - cb.hp) * 0.045);
    if (cb.hp !== car.hp) {
      car.hp = cb.hp;
      setPaintDamage(car.paint, (1 - car.hp / MAX_HP) * 0.55);
    }
    if (car.alive && !cb.alive) {
      car.alive = false;
      setPaintDamage(car.paint, 1);
      car.paint.emissiveIntensity = 0;
      refreshOccupantVisuals(car);
    }
    for (const seat of GUN_SEATS) {
      const g = gunAt(car, seat),
        ga = ca.guns[seat - 1]!,
        gb = cb.guns[seat - 1]!;
      const mine = G.humans.some(
        (h: Human) =>
          h.car === car && ((h.seat === seat && h.aim) || (h.seat === 0 && (h.lookBack ? 2 : 1) === seat)),
      );
      if (!mine) {
        g.yaw = lerpA(ga.yaw, gb.yaw, t);
        g.pitch = mix(ga.pitch, gb.pitch, t);
        g.zoom = gb.zoom;
      }
      g.loft = mix(ga.loft, gb.loft, t);
      g.heat = gb.heat;
      g.recoil = gb.recoil;
      if (gb.jam && !g.jam && mine) SFX.fail();
      g.overheat = gb.overheat;
      g.jam = gb.jam;
      g.firing = gb.firing;
    }
  });
}

/** This screen's players: their own controls, what they do here at once, and what goes to the host. */
function playerControls(h: Human, dt: number): Controls {
  followDevice(h);
  const ctl = readControls(h, dt);
  h.orbit = ctl.orbit;
  if (h.dead || !h.car || !h.car.alive) {
    if (ctl.switchP) cycleWatch(h);
    return NO_CONTROLS;
  }
  const car = h.car;
  if (h.seat !== 0 && ctl.seatTo && ctl.seatTo !== h.seat) {
    ask(h, { a: 'switch', to: ctl.seatTo });
    return NO_CONTROLS;
  }
  if (ctl.switchP) {
    ask(h, { a: 'switch' });
    return NO_CONTROLS;
  }
  const frame: Controls = {
    ...NO_CONTROLS,
    throttle: ctl.throttle,
    steer: ctl.steer,
    handbrake: ctl.handbrake,
    boost: ctl.boost,
  };
  if (h.seat === 0) {
    if (ctl.camP) h.camMode = h.camMode === 'chase' ? 'cockpit' : 'chase';
    const lookBack = !h.device.startsWith('pad') && ctl.zoom;
    h.lookBack = lookBack;
    const gunSeat = lookBack ? 2 : 1;
    const g = gunAt(car, gunSeat);
    if (lookBack) h.relYawB = clamp((h.relYawB ?? 0) + ctl.dYaw, -TURRETS.trunk.arc, TURRETS.trunk.arc);
    else h.relYawF = clamp((h.relYawF ?? 0) + ctl.dYaw, -TURRETS.hood.arc, TURRETS.hood.arc);
    gunAt(car, 1).yaw = wrapPi(car.yaw + TURRETS.hood.center + (h.relYawF ?? 0));
    gunAt(car, 2).yaw = wrapPi(car.yaw + TURRETS.trunk.center + (h.relYawB ?? 0));
    g.pitch += ctl.dPitch;
    clampGunToArc(car, 1);
    clampGunToArc(car, 2);
    if (g.jam) {
      const J = (h.jamGame ||= GAMES.unjam.init());
      if (GAMES.unjam.update(J, ctl, dt)) {
        h.jamGame = null;
        ask(h, { a: 'unjam' });
        SFX.ok();
      }
    } else h.jamGame = null;
    Object.assign(frame, {
      fire: ctl.fire && !g.jam,
      zoom: lookBack,
      aimYaw: g.yaw,
      aimPitch: g.pitch,
      aimX: g.aimPoint.x,
      aimY: g.aimPoint.y,
      aimZ: g.aimPoint.z,
    });
  } else if (h.seat === 3) {
    updateHumanMechanic(h, ctl, dt); // the jobs are played here; a finished one goes to the host
    car.pouring = h.mech?.game?.type === 'pour';
    if ((h.pourT = (h.pourT || 0) - dt) <= 0) {
      h.pourT = 0.2;
      sendPour(h);
    }
  } else {
    // the turret moves on this screen at once; the host takes where it points
    const g = gunAt(car, h.seat);
    h.aim ??= { yaw: g.yaw, pitch: g.pitch };
    const zf = g.zoom > 0.5 ? 0.45 : 1;
    g.yaw = h.aim.yaw + ctl.dYaw * zf;
    g.pitch = h.aim.pitch + ctl.dPitch * zf;
    clampGunToArc(car, h.seat);
    h.aim.yaw = g.yaw;
    h.aim.pitch = g.pitch;
    g.zoom = clamp(damp(g.zoom, ctl.zoom ? 1 : 0, 14, dt), 0, 1);
    if (g.jam) {
      const J = (h.jamGame ||= GAMES.unjam.init());
      if (GAMES.unjam.update(J, ctl, dt)) {
        h.jamGame = null;
        ask(h, { a: 'unjam' });
        SFX.ok();
      }
    } else h.jamGame = null;
    Object.assign(frame, {
      fire: ctl.fire && !g.jam,
      zoom: ctl.zoom,
      aimYaw: g.yaw,
      aimPitch: g.pitch,
      aimX: g.aimPoint.x,
      aimY: g.aimPoint.y,
      aimZ: g.aimPoint.z,
    });
  }
  return frame;
}

function showFlow(dt: number): void {
  if (G.state !== prevState) {
    if (G.state === 'playing') {
      goT = 1;
      SFX.count(true);
    }
    prevState = G.state;
  }
  if (G.state === 'countdown') {
    const n = Math.ceil(timer - 0.5);
    if (n !== lastCount && n >= 1 && n <= 3) {
      lastCount = n;
      SFX.count(false);
    }
    setCenter(timer > 0.5 ? `${Math.max(1, n)}<small>Round ${G.round}</small>` : '');
  } else if (G.state === 'playing') {
    lastCount = 4;
    goT -= dt;
    setCenter(goT > 0 ? 'GO!' : '');
  } else if (G.state === 'over') {
    const w = G.winnerTeam;
    const title =
      w >= 0
        ? `<span style="color:${requireValue(TEAMS[w]).ui}">${requireValue(TEAMS[w]).name.toUpperCase()} WINS</span>`
        : 'DRAW';
    setCenter(
      `${title}<small>${lifecycle().standings()}</small><small>Next round in ${Math.max(0, Math.ceil(timer))}</small>`,
    );
  }
}

/** The replica's whole frame (instead of the host's tick). */
export function replicaTick(dt: number, draw: boolean): void {
  const running = G.state === 'countdown' || G.state === 'playing' || G.state === 'over';
  applySnapshots();
  if (running) {
    G.time += dt;
    const frames: [number, Controls][] = G.humans.map((h: Human) => [
      h.localIndex ?? 0,
      playerControls(h, dt),
    ]);
    ctrlClock += dt;
    const z = getSession();
    if (z && frames.length && ctrlClock >= 1 / CONTROLS_PER_SECOND) {
      ctrlClock %= 1 / CONTROLS_PER_SECOND;
      z.net.stream(HOST, MSG.ctrl, writeControls(z.net.begin(), frames));
    }
    for (const car of G.cars) lifecycle().carFx(car, dt);
    updateBullets(dt);
    showFlow(dt);
    const local = new Set(G.humans.filter((h: Human) => !h.dead).map((h: Human) => h.car));
    for (const car of G.cars) SFX.engine(car, local.has(car) && car.alive);
  }
  for (const car of G.cars) updateRadar(car, dt);
  updateDebris(dt);
  updateBreakables(dt);
  updateConfetti(dt);
  updateDrops(dt);
  updatePaint(dt, running);
  GLOW.update(dt);
  SMOKE.update(dt);
  if (!draw) return;
  for (const car of G.cars) syncCarVisual(car, dt);
  for (const h of G.humans) updateCamera(h, dt);
  updateAimPoints();
  drawBalls();
  render(dt);
  updateHud(dt);
  updateScores();
}

// ---- waiting for the host to start ----

const waitingEl = (): HTMLElement | null => document.getElementById('netWait');

function setWaiting(text: string): void {
  const p = waitingEl()?.querySelector('.wait-status');
  if (p) p.textContent = text;
}

const ROLES = ['Driver'];

/** The host's setup, read only: who sits where. This screen's own seats are marked "you". */
function showWaiting(): void {
  const el = waitingEl();
  if (!el) return;
  document.getElementById('menu')?.classList.add('hidden');
  el.classList.remove('hidden');
  const list = el.querySelector('.wait-cars');
  if (!list) return;
  list.textContent = '';
  const me = mySeat();
  const cars = Array.isArray(lastSetup?.['cars'])
    ? (lastSetup['cars'] as unknown[]).slice(0, 8).map(asObject)
    : [];
  cars.forEach((c, ci) => {
    const team = TEAMS[asInt(c['team'], 0, TEAMS.length - 1, 0)]!;
    const row = document.createElement('div');
    row.className = 'wait-car';
    row.style.setProperty('--team', team.ui);
    const name = document.createElement('b');
    name.textContent = `${ci + 1} · ${team.name}`;
    row.append(name);
    const seats = Array.isArray(c['seats']) ? c['seats'] : [];
    ROLES.forEach((role, ri) => {
      const t = asSeatTaker(seats[ri]);
      const span = document.createElement('span');
      const you = t !== 'bot' && t !== 'empty' && t.p === me;
      span.textContent = `${role}: ${t === 'bot' ? 'CPU' : t === 'empty' ? '–' : you ? 'you' : nameOf(t.p, t.i).name}`;
      if (you) span.className = 'you';
      row.append(span);
    });
    list.append(row);
  });
  setWaiting(cars.length ? 'Waiting for the host to start.' : 'Connecting to the host…');
}

function hideWaiting(): void {
  waitingEl()?.classList.add('hidden');
}
