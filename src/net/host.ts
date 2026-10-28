import { requireValue } from '../required-fields.ts';
import { RoundMetrics, createRoundMetricReporter } from '../gameplay/metrics.ts';
import { sendRoomMusic } from './music-room.ts';
import { currentCompetitionSummary, recordCompetitionFuel } from '../competition.ts';
import { gunAt, isGunSeat } from '../gameplay/guns.ts';
import { crew, sendCrew, resetCrew } from './crew.ts';
import * as THREE from 'three';
import type * as ZN from '/zirbel-net.js';
import { damp } from '../core.ts';
import { refreshOccupantVisuals, updatePlayerTag } from '../car.ts';
import { G } from '../state.ts';
import { gunMuzzle } from '../combat.ts';
import { aimDir } from '../gameplay/geometry.ts';
import { clampGunToArc, makeBot, switchSeat } from '../control.ts';
import { DEFAULT_KITS, KIT_NAMES } from '../kit-data.ts';
import { applyFix, mechTasks, startFire } from '../mechanic.ts';
import { CAN_FUEL } from '../mechanic-data.ts';
import { OBSTACLES } from '../world.ts';
import { lifecycle } from '../lifecycle.ts';
import { carDetail } from './detail.ts';
import { recordInto, recorded } from './effects.ts';
import {
  MSG,
  PEER_SLOT,
  PROTOCOL,
  SNAPS_PER_SECOND,
  asInt,
  asNumber,
  asObject,
  asSeatTaker,
  parseJson,
  peerOfSlot,
  type SeatTaker,
} from './protocol.ts';
import {
  readControls as readControlFrames,
  writeSnapshot,
  STATES,
  type Controls,
  type RoundState,
  type Snapshot,
} from './snapshot.ts';
import { lastSetup } from './context.ts';
import { localDevice } from '../local-device.ts';
import { getSession, mySeat, peerSeats } from './context.ts';
import { D, dataRevision } from '../data.ts';
import type { RemoteHuman as Human } from '../human-types.ts';
import type { Car } from '../car.ts';
import type { GunState } from '../gameplay/model.ts';
import type { Setup } from '../setup.ts';
/**
 * The host's side: this screen runs the game for the room. Players who join get a seat (a bot's),
 * their controls drive their seats, and everyone gets what they need to draw the game: the round,
 * who sits where, snapshots of the cars, each car's detail when it changes, and the effects.
 * Everything a player sends is checked: only their own seats, values in range, jobs that exist.
 */

const roundMetrics = new RoundMetrics();
const ALL = 0; // zirbel-net's ALL
let fx: ZN.Writer | null = null;
let snapClock = 0;
const lastDetail = new Map<number, { json: string; at: number }>();
let lastFlow = '';
const sent = { snapsSent: 0, fxSent: 0 };
/** What this screen has sent as host, for tests and the console (derby.net). */
export const hostDebug = () => ({ ...sent, peers: peerSeats().length });

// ---- seats ----

const RUNNING = new Set(['countdown', 'playing', 'over']);

/** Who sits in a seat of the setup, as the other screens see it. The host's own players are i = 0, 1… */
function seatTaker(slot: string, localIndex: Map<string, number>): SeatTaker {
  if (slot === 'bot' || slot === 'empty') return slot;
  const p = peerOfSlot(slot);
  if (p) return { p, i: 0 };
  return { p: mySeat(), i: localIndex.get(slot) ?? 0 };
}

/** The setup as everyone sees it. */
export function publicSetup(): unknown {
  const setup = lifecycle().getSetup(),
    local = new Map<string, number>();
  for (const c of setup.cars)
    for (const s of c.seats)
      if (s !== 'bot' && s !== 'empty' && !peerOfSlot(s) && !local.has(s)) local.set(s, local.size);
  return {
    mapSeed: setup.mapSeed,
    botSkill: setup.botSkill,
    cars: setup.cars.map((c) => ({
      team: c.team,
      kit: c.kit,
      seats: c.seats.map((s) => seatTaker(s, local)),
    })),
  };
}

/** Who sits where right now, car by car. */
/** A player who joined gets a bot's seat: a driver's if one is free. In a round, right away. */
export function hostPeerJoined(id: number): void {
  const setup = lifecycle().getSetup(),
    slot = PEER_SLOT + id;
  if (!setup.cars.some((c) => c.seats.includes(slot))) {
    // In a round, a seat a bot has right now (people may have changed seats since the setup)
    const running = RUNNING.has(G.state);
    const botInSetup = (ci: number, si: number): boolean => setup.cars[ci]?.seats[si] === 'bot';
    const spot = firstSeat(
      setup.cars.length,
      running ? (ci, si) => G.cars[ci]?.occ[si]?.kind === 'bot' : botInSetup,
    );
    if (spot) {
      // the setup keeps it for the next rounds: the same seat if a bot has it there too, else the first that does
      const keep = botInSetup(...spot) ? spot : firstSeat(setup.cars.length, botInSetup);
      if (keep) setup.cars[keep[0]]!.seats[keep[1]] = slot;
      if (running) seatLive(id, requireValue(G.cars[spot[0]]), spot[1]);
    }
  }
  if (G.state === 'menu') lifecycle().renderSetup();
  sendHello(id);
  broadcast(MSG.setup, publicSetup());
  sendCrew();
}

/** The first car whose driver seat passes free(). Each car is one person only. */
function firstSeat(cars: number, free: (ci: number, si: number) => boolean): [number, number] | null {
  for (let ci = 0; ci < cars; ci++) if (free(ci, 0)) return [ci, 0];
  return null;
}

function seatLive(peer: number, car: Car, seat: number): void {
  const occ = car.occ[seat];
  if (occ && occ.kind === 'human') return; // someone is there
  const h = lifecycle().makeRemote(peer, car, seat);
  G.remotes.push(h);
  car.occ[seat] = { kind: 'human', h };
  refreshOccupantVisuals(car);
  updatePlayerTag(car);
}

/** A player left: their seats go back to bots. */
export function hostPeerLeft(id: number): void {
  const setup = lifecycle().getSetup(),
    slot = PEER_SLOT + id;
  for (const c of setup.cars) c.seats = c.seats.map((s) => (s === slot ? 'bot' : s));
  for (const h of G.remotes.filter((x: Human) => x.peer === id)) {
    G.remotes.splice(G.remotes.indexOf(h), 1);
    const car = h.car;
    const occupant = car?.occ[h.seat];
    if (occupant?.kind === 'human' && occupant.h === h) car.occ[h.seat] = makeBot(car, h.seat);
    if (car) {
      refreshOccupantVisuals(car);
      updatePlayerTag(car);
    }
  }
  asks.delete(id);
  if (G.state === 'menu') lifecycle().renderSetup();
  broadcast(MSG.setup, publicSetup());
  sendCrew();
}

// ---- what players send ----

/** Controls for a player's seats, by their index on that player's screen. */
export function hostControls(from: number, r: ZN.Reader): void {
  const list = readControlFrames(r);
  if (!list) return;
  for (const [i, c] of list) {
    const h = G.remotes.find((x: Human) => x.peer === from && x.peerIndex === i);
    if (h) {
      h.frame = c;
      h.frameAt = performance.now();
    }
  }
}

const _gunDir = new THREE.Vector3(),
  _muzzle = new THREE.Vector3(),
  _toAim = new THREE.Vector3();
/** How far off the gun's line a crosshair may be (the turret camera sits a little behind and above it). */
const AIM_CONE = Math.cos(0.35);

/** A player on another screen drives their seat with their latest controls. Held keys let go if their link goes quiet. */
export function driveRemote(h: Human, dt: number): void {
  const car = h.car;
  if (!car || !car.alive) return;
  const c: Controls | null = h.frame && performance.now() - h.frameAt < 1000 ? h.frame : null;
  if (h.seat === 0) {
    if (G.state === 'playing' && c)
      Object.assign(car.ctrl, {
        throttle: c.throttle,
        steer: c.steer,
        handbrake: c.handbrake,
        boost: c.boost,
      });
    else Object.assign(car.ctrl, { throttle: 0, steer: c ? c.steer : 0, handbrake: true, boost: false });
    const gunSeat = c?.zoom ? 2 : 1,
      otherSeat = c?.zoom ? 1 : 2;
    gunAt(car, otherSeat).firing = false;
    gunAt(car, otherSeat).zoom = 0;
    const g = gunAt(car, gunSeat);
    if (c) {
      g.yaw = c.aimYaw;
      g.pitch = c.aimPitch;
      clampGunToArc(car, gunSeat);
      aimDir(g.yaw, g.pitch, _gunDir);
      gunMuzzle(car, gunSeat, _muzzle);
      _toAim.set(c.aimX, c.aimY, c.aimZ).sub(_muzzle);
      const len = _toAim.length();
      if (len > 2 && _toAim.dot(_gunDir) > len * AIM_CONE) g.aimPoint.set(c.aimX, c.aimY, c.aimZ);
      else g.aimPoint.copy(_muzzle).addScaledVector(_gunDir, Math.max(len, 20));
    }
    g.firing = G.state === 'playing' && !!c && c.fire && !g.jam;
    if (g.jam) h.jamSince ??= performance.now();
    else delete h.jamSince;
  } else if (isGunSeat(h.seat)) {
    const g = gunAt(car, h.seat);
    if (c) {
      g.yaw = c.aimYaw;
      g.pitch = c.aimPitch;
      clampGunToArc(car, h.seat);
      // the crosshair's point, as long as it lies along the gun: nobody shoots round corners
      aimDir(g.yaw, g.pitch, _gunDir);
      gunMuzzle(car, h.seat, _muzzle);
      _toAim.set(c.aimX, c.aimY, c.aimZ).sub(_muzzle);
      const len = _toAim.length();
      if (len > 2 && _toAim.dot(_gunDir) > len * AIM_CONE) g.aimPoint.set(c.aimX, c.aimY, c.aimZ);
      else g.aimPoint.copy(_muzzle).addScaledVector(_gunDir, Math.max(len, 20));
    }
    g.firing = !!c && c.fire && !g.jam;
    g.zoom = damp(g.zoom, c && c.zoom ? 1 : 0, 14, dt);
    if (g.jam)
      h.jamSince ??= performance.now(); // clearing it takes a moment: see hostAsk
    else delete h.jamSince;
  }
}

/** Asks a player may send: a few a second, with room for a short burst. */
const ASK_RATE = 12;
const asks = new Map<number, { tokens: number; at: number }>();
function askAllowed(from: number, now: number): boolean {
  const b = asks.get(from) ?? { tokens: ASK_RATE, at: now };
  b.tokens = Math.min(ASK_RATE, b.tokens + ((now - b.at) / 1000) * ASK_RATE);
  b.at = now;
  asks.set(from, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** The largest ask, and how fast a person can really do things: a job, clearing a jam, changing seat, a spill. */
const ASK_MAX = 512,
  JOB_MS = 1500,
  UNJAM_MS = 600,
  SWITCH_MS = 400,
  SPILL_MS = 1500;
/** The can pours this fast; a few frames' worth can be banked between asks. */
const POUR_RATE = 38,
  POUR_BANK = 10;

/** A player asks for something only the host can do: change seat, finish a job, pour, clear a jam. */
export function hostAsk(from: number, r: ZN.Reader): void {
  const now = performance.now();
  if (!askAllowed(from, now) || r.left() > ASK_MAX) return; // charged first, and never read when too big
  const a = asObject(parseJson(r.text()));
  if (a['a'] === 'sync') {
    sendHello(from);
    sendCrew(from);
    return;
  } // a screen that reloaded, or lost messages
  const h = G.remotes.find((x: Human) => x.peer === from && x.peerIndex === asInt(a['i'], 0, 3, 0));
  if (!h || !h.car || !h.car.alive || !RUNNING.has(G.state)) return;
  const car = h.car;
  if (a['a'] === 'switch') {
    const to = a['to'] === 1 || a['to'] === 2 || a['to'] === 3 ? a['to'] : undefined;
    if (to !== undefined && (h.seat === 0 || h.seat === to)) return;
    if (now - (h.switchAt ?? -1e9) < SWITCH_MS) return;
    h.switchAt = now;
    // leaving a pour half-done still uses the can up, as it does on the host's own screen
    if (h.seat === 3 && (h.poured ?? 0) > 0 && car.stock.fuel > 0) {
      car.stock.fuel--;
      h.poured = 0;
    }
    switchSeat(h, to); // tells everyone
  } else if (a['a'] === 'fix' && h.seat === 3 && typeof a['task'] === 'string') {
    if (now - (h.fixAt ?? -1e9) < JOB_MS) return; // nobody finishes a job faster than that
    // the job must still be there, and doable: the mechanic's screen worked it out from the same state.
    // A tank that has been poured full isn't a job any more, but the can is still used up.
    const task =
      mechTasks(car).find((t: { id: string; need?: string }) => t.id === a['task'] && !t.need) ??
      (a['task'] === 'fuel' && car.stock.fuel > 0 && (h.poured ?? 0) > 0
        ? { id: 'fuel', kind: 'fuel' as const, label: 'Refuel', urg: 0 }
        : null);
    if (task && applyFix(car, task, false)) {
      h.fixAt = now;
      if (task.kind === 'fuel') h.poured = 0;
    }
  } else if (a['a'] === 'pour' && h.seat === 3 && car.stock.fuel > 0) {
    h.pourBank = Math.min(
      POUR_BANK,
      (h.pourBank ?? POUR_BANK) + ((now - (h.pourAt ?? now)) / 1000) * POUR_RATE,
    );
    h.pourAt = now;
    const d = Math.min(asNumber(a['d'], 0, CAN_FUEL, 0), h.pourBank, CAN_FUEL - (h.poured ?? 0));
    if (d > 0) {
      h.pourBank -= d;
      const beforeFuel = car.sys.fuel;
      car.sys.fuel = Math.min(100, car.sys.fuel + d);
      recordCompetitionFuel(car, car.sys.fuel - beforeFuel);
      h.poured = (h.poured ?? 0) + d;
    }
    // a spill needs a tank that's nearly full, and not another straight away
    if (a['spill'] === true && car.sys.fuel >= 85 && now - (h.spillAt ?? -1e9) >= SPILL_MS) {
      h.spillAt = now;
      car.sys.fuel = Math.min(car.sys.fuel, 90);
      if (Math.random() < 0.15) startFire(car, 1);
    }
  } else if (a['a'] === 'unjam' && (h.seat === 0 || isGunSeat(h.seat))) {
    const gunSeat = h.seat === 0 ? (h.frame?.zoom ? 2 : 1) : h.seat;
    const g = gunAt(car, gunSeat);
    if (g.jam && h.jamSince !== undefined && now - h.jamSince >= UNJAM_MS) {
      g.jam = false;
      g.overheat = false;
      g.heat = Math.min(g.heat, 0.45);
      delete h.jamSince;
    }
  }
}

// ---- what the host sends ----

function broadcast(type: number, value: unknown, to = ALL): void {
  const s = getSession();
  if (s && peerSeats().length) s.net.send(to, type, JSON.stringify(value));
}

function sendHello(to: number): void {
  const s = getSession();
  if (!s) return;
  s.net.send(
    to,
    MSG.hello,
    JSON.stringify({ protocol: PROTOCOL, setup: publicSetup(), state: G.state, rev: dataRevision() }),
  );
  sendRoomMusic(to);
  if (RUNNING.has(G.state)) {
    s.net.send(to, MSG.round, JSON.stringify(roundInfo()));
    for (const car of G.cars) s.net.send(to, MSG.detail, JSON.stringify(carDetail(car)));
    s.net.send(to, MSG.flow, JSON.stringify(flowInfo()));
  }
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

function roundInfo(): unknown {
  return {
    // the revision of the data this round is played with ('' for the game's own): every screen loads it first
    round: G.round,
    mapSeed: G.cfg.mapSeed,
    botSkill: G.cfg.botSkill,
    rev: dataRevision(),
    cars: G.cars.map((c: Car) => ({
      team: c.team,
      kit: c.cfg.kit || 'stock',
      x: c.pos.x,
      z: c.pos.z,
      yaw: c.yaw,
    })),
    crew: crew(),
    // lamp posts, trees and bollards that are down, and the way they fell
    down: OBSTACLES.flatMap((o: { down?: boolean; brk?: { dir: [number, number] } }, i: number) =>
      o.down ? [[i, r2(o.brk?.dir[0] ?? 1), r2(o.brk?.dir[1] ?? 0)]] : [],
    ),
    // supply drops still waiting to be picked up
    drops: G.drops
      .filter((d: { taken: number }) => d.taken < 0)
      .map((d: { id: number; type: string; x: number; z: number }) => [d.id, d.type, r2(d.x), r2(d.z)]),
  };
}

function flowInfo(): unknown {
  return {
    summary: currentCompetitionSummary(),
    round: G.round,
    winnerTeam: G.winnerTeam,
    points: G.points.map(Math.round),
    teamScores: G.teamScores,
  };
}

/** A round started: everyone builds it. */
export function hostRoundStarted(): void {
  roundMetrics.begin(G);
  lastDetail.clear();
  resetCrew(JSON.stringify(crew())); // the round carries it
  broadcast(MSG.round, roundInfo());
  for (const car of G.cars) broadcast(MSG.detail, carDetail(car));
}

/** Back at the setup screen, or the setup changed. */
export function hostSetupChanged(): void {
  broadcast(MSG.setup, publicSetup());
  broadcast(MSG.flow, { ...(flowInfo() as object), state: G.state });
}

/** Before the game's tick: effects get recorded while there's someone to send them to. */
export function hostTickBegin(): void {
  const s = getSession();
  if (!s || !peerSeats().length) {
    recordInto(null);
    return;
  }
  fx ??= new s.zn.Writer(4096);
  recordInto(fx.reset());
}

/** After it: the effects, the snapshot when one is due, details that changed, and the score. */
export function hostTickEnd(dt: number): void {
  const s = getSession();
  if (s?.net.isHost()) {
    // Older standalone SDKs have no metrics channel. Never send results as player messages.
    const port: object = s.net;
    if ('metric' in port && typeof port.metric === 'function') {
      const metric = port.metric.bind(port) as (
        name: string,
        value: number,
        labels: Readonly<Record<string, string>>,
      ) => unknown;
      roundMetrics.update(
        G,
        createRoundMetricReporter(metric, {
          cars: G.cfg.cars.length,
          bots: G.cfg.botSkill,
          format: D.rounds.map,
        }),
      );
    }
  }
  const effects = recorded(); // (before recordInto(null), which starts the count again)
  recordInto(null);
  if (!s || !peerSeats().length) return;
  if (fx && effects > 0) {
    s.net.send(ALL, MSG.fx, fx);
    sent.fxSent++;
  }
  if (!RUNNING.has(G.state)) return;
  snapClock += dt;
  if (snapClock >= 1 / SNAPS_PER_SECOND) {
    snapClock %= 1 / SNAPS_PER_SECOND;
    s.net.stream(ALL, MSG.snap, writeSnapshot(s.net.begin(), snapshot(s.net.now())));
    sent.snapsSent++;
  }
  const now = performance.now();
  for (const car of G.cars) {
    const json = JSON.stringify(carDetail(car)),
      last = lastDetail.get(car.idx);
    if (last && (last.json === json || now - last.at < 100)) continue;
    lastDetail.set(car.idx, { json, at: now });
    s.net.send(ALL, MSG.detail, json);
  }
  // Rich round reports can be large; serialize only when their small change key changes.
  const flowKey = JSON.stringify([
    G.round,
    G.winnerTeam,
    G.points.map(Math.round),
    G.teamScores,
    currentCompetitionSummary()?.round ?? null,
  ]);
  if (flowKey !== lastFlow) {
    lastFlow = flowKey;
    s.net.send(ALL, MSG.flow, JSON.stringify(flowInfo()));
  }
}

function snapshot(time: number): Snapshot {
  const state: RoundState = (STATES as readonly string[]).includes(G.state)
    ? (G.state as RoundState)
    : 'menu';
  const gun = (g: GunState) => ({
    yaw: g.yaw,
    pitch: g.pitch,
    loft: g.loft || 0,
    heat: g.heat,
    recoil: g.recoil,
    zoom: g.zoom,
    overheat: !!g.overheat,
    jam: !!g.jam,
    firing: !!g.firing,
  });
  return {
    time,
    state,
    timer: state === 'countdown' ? G.countdown : state === 'over' ? G.overTimer : 0,
    cars: G.cars.map((c: Car) => ({
      alive: c.alive,
      grounded: c.grounded,
      boosting: !!c.boosting,
      handbrake: !!c.ctrl.handbrake,
      burnOn: !!(c.burn && c.burn.on),
      x: c.pos.x,
      y: c.pos.y,
      z: c.pos.z,
      yaw: c.yaw,
      vx: c.vel.x,
      vy: c.vel.y,
      vz: c.vel.z,
      yawRate: c.yawRate,
      steer: c.steer,
      throttle: c.ctrl.throttle,
      leanP: c.lean.p,
      leanR: c.lean.r,
      land: c.land,
      hp: c.hp,
      boostFuel: c.boostFuel,
      burnT: c.burn ? c.burn.t : 0,
      guns: [gun(gunAt(c, 1)), gun(gunAt(c, 2))],
    })),
  };
}

/** The link came back: messages may have been lost on the way, so everyone gets everything again. */
export function hostResend(): void {
  lastDetail.clear();
  lastFlow = '';
  resetCrew();
  for (const id of peerSeats()) sendHello(id);
  sendCrew();
}

/**
 * The old host's setup, as this screen takes over: this screen's players keep their seats (with the
 * controls they play with), the others' become online seats, and bots stay bots.
 */
function takeOverSetup(pub: Record<string, unknown>): Setup | null {
  const cars = Array.isArray(pub['cars']) ? pub['cars'].map(asObject) : [];
  const now = lifecycle().getSetup();
  if (cars.length < 2 || cars.length > 8) return null; // 2 to 8 cars, one per team colour
  const me = mySeat(),
    mine = new Map<number, string>(G.humans.map((h) => [h.localIndex ?? 0, h.device]));
  return {
    botSkill: asInt(pub['botSkill'], 0, 2, now.botSkill),
    mapSeed: asInt(pub['mapSeed'], 1, 99999, now.mapSeed),
    cars: cars.map((c, ci) => {
      const seats = Array.isArray(c['seats']) ? c['seats'] : [];
      const kit =
        typeof c['kit'] === 'string' && Object.hasOwn(KIT_NAMES, c['kit'])
          ? c['kit']
          : requireValue(DEFAULT_KITS[ci % DEFAULT_KITS.length]);
      return {
        team: ci,
        kit,
        seats: [0, 1, 2, 3].map((si) => {
          if (si > 0) return 'bot';
          const t = asSeatTaker(seats[si]);
          if (t === 'bot' || t === 'empty') return 'bot';
          return t.p === me ? (mine.get(t.i) ?? localDevice()) : PEER_SLOT + t.p;
        }),
      };
    }),
  };
}

/** This screen just became host. Taking over from a host who left: the match goes on, with the same people. */
export function hostStart(tookOver: boolean): void {
  if (tookOver) {
    const next = lastSetup ? takeOverSetup(lastSetup) : null;
    lifecycle().clearArena();
    G.state = 'menu';
    if (next) lifecycle().setSetup(next);
  }
  const setup = lifecycle().getSetup();
  // seats of players who aren't here any more go to bots
  const here = new Set(peerSeats());
  for (const c of setup.cars)
    c.seats = c.seats.map((s) => (peerOfSlot(s) && !here.has(peerOfSlot(s)) ? 'bot' : s));
  lifecycle().saveSetup();
  if (tookOver) {
    lifecycle().buildMap(setup.mapSeed, setup.cars.length);
    lifecycle().startGame(true);
  }
  for (const id of peerSeats()) hostPeerJoined(id);
}

export function hostStop(): void {
  recordInto(null);
  fx = null;
  lastDetail.clear();
  lastFlow = '';
  resetCrew();
  asks.clear();
  if (G.state !== 'menu') lifecycle().toMenu();
}

/** The hub ended the session: the others' seats go to bots, and the round goes on, offline. */
export function hostLost(): void {
  for (const h of G.remotes) {
    const car = h.car;
    const occupant = car?.occ[h.seat];
    if (occupant?.kind === 'human' && occupant.h === h) car.occ[h.seat] = makeBot(car, h.seat);
    if (car) {
      refreshOccupantVisuals(car);
      updatePlayerTag(car);
    }
  }
  G.remotes = [];
  const setup = lifecycle().getSetup();
  for (const c of setup.cars) c.seats = c.seats.map((s) => (peerOfSlot(s) ? 'bot' : s));
  recordInto(null);
  fx = null;
  lastDetail.clear();
  lastFlow = '';
  resetCrew();
  asks.clear();
}
