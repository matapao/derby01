/**
 * What crashes, wrecks, shots and scores look and sound like: the visible half of the game's events,
 * kept apart from the rules that cause them, so every screen can draw them (see net/effects.ts).
 * The host's game calls these; the other screens replay them with the same arguments and seed.
 * Feed lines and notes are built here from car numbers and fixed texts, never from text sent over.
 */
import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import { isDropKind } from './gameplay/supplies.ts';
import * as THREE from 'three';
import { CARDIM, TEAMS } from './core.ts';
import { G } from './state.ts';
import { carLabel, shakeCarCrew } from './crew-effects.ts';
import { SMOKE, confettiBurst, dust, sparks } from './fx.ts';
import { SFX } from './audio.ts';
import { paintBurst, paintCss } from './paint.ts';
import { FX, share } from './net/effects.ts';
import { isReplica } from './net/role.ts';
import { feed, crewNote } from './feedback.ts';
import { popPoints } from './points-ui.ts';
import type { ScoreEvent } from './gameplay/scoring.ts';
import { DROP_TYPES } from './drop-data.ts';
import { carToWorld } from './gameplay/geometry.ts';
import { RADAR } from './radar-model.ts';

const _p = new THREE.Vector3();

/** Two cars crashed at (x, y, z). */
export function crashFx(x: number, y: number, z: number, strength: number, a: Car | null, b: Car | null) {
  if (share(FX.crash, crashFx, [x, y, z, strength, a, b])) return;
  sparks(x, y, z, Math.min(40, strength * 3), strength);
  if (strength > 4) dust(x, 0.3, z, 3);
  SFX.crash(_p.set(x, y, z), strength);
  if (a) shakeCarCrew(a, strength * 0.06);
  if (b) shakeCarCrew(b, strength * 0.06);
}

/** A car hit a wall or a building; b is null. Or it landed hard: then strength is the landing's. */
export function knockFx(kind: 'land' | 'wall', car: Car, x: number, y: number, z: number, strength: number) {
  if (share(FX.knock, knockFx, [kind, car, x, y, z, strength])) return;
  if (kind === 'land') {
    dust(x, y + 0.2, z, Math.min(14, strength * 1.5));
    SFX.crash(_p.set(x, y, z), strength * 0.45);
    shakeCarCrew(car, strength * 0.03);
  } else {
    sparks(x, y, z, Math.min(30, strength * 3), strength);
    SFX.crash(_p.set(x, y, z), strength * 0.8);
    shakeCarCrew(car, strength * 0.05);
  }
}

/** A car is out: it goes off like a party popper, and the winner's colour gets all over it. */
export function wreckFx(
  car: Car,
  killer: Car | null,
  cause: import('./gameplay/model.ts').DamageCause,
  x: number,
  y: number,
  z: number,
) {
  if (share(FX.wreck, wreckFx, [car, killer, cause, x, y, z])) return;
  confettiBurst(x, y + 1.2, z, 1600);
  SFX.popper(_p.set(x, y, z));
  for (const h of G.humans) {
    const d = h.cam.position.distanceTo(_p);
    h.shake = Math.min(1.2, h.shake + Math.max(0, 0.6 - d * 0.03));
  }
  if (killer && killer !== car) paintBurst(x, y + 1, z, paintCss(killer.team), true);
  feed(
    killer && killer !== car
      ? `<b style="--c:${requireValue(TEAMS[killer.team]).ui}">${carLabel(killer)}</b> ${cause === 'gun' ? 'splatted' : 'wrecked'} <b style="--c:${requireValue(TEAMS[car.team]).ui}">${carLabel(car)}</b>`
      : `<b style="--c:${requireValue(TEAMS[car.team]).ui}">${carLabel(car)}</b> is out`,
  );
  for (const h of G.humans) {
    if (h.car === car) {
      h.dead = true;
      h.watch = car;
      h.watchT = 0;
    } else if (killer && h.car === killer) {
      h.hitMark = 1;
      h.killMark = 1;
    }
  }
}

/**
 * A gun fired a ball from the muzzle at (mx, my, mz) with velocity (vx, vy, vz): the puff and the
 * sound everywhere, and on the other screens a ball to watch fly (the host's game has the real one).
 */
export function shotFx(
  car: Car,
  seat: number,
  mx: number,
  my: number,
  mz: number,
  vx: number,
  vy: number,
  vz: number,
) {
  if (share(FX.shot, shotFx, [car, seat, mx, my, mz, vx, vy, vz])) return;
  const sp = Math.hypot(vx, vy, vz) || 1;
  SMOKE.emit({
    x: mx,
    y: my,
    z: mz,
    vx: (vx / sp) * 3,
    vy: (vy / sp) * 3 + 0.3,
    vz: (vz / sp) * 3,
    life: 0.35,
    s0: 0.12,
    s1: 0.5,
    c0: [0.92, 0.94, 0.96, 0.35],
    c1: [0.95, 0.95, 0.95, 0],
    drag: 3,
  });
  _p.set(mx, my, mz);
  SFX.gun(_p);
  // a ball to watch fly, while someone watches: a hidden tab doesn't move them, and there's a ceiling
  if (isReplica() && !document.hidden && G.bullets.length < MAX_WATCHED_BALLS) {
    const css = paintCss(car.team);
    G.bullets.push({
      p: _p.clone(),
      v: new THREE.Vector3(vx, vy, vz),
      dmg: 0,
      car,
      team: car.team,
      shooter: null,
      age: 0,
      css,
      color3: new THREE.Color(css),
      seen: true,
    });
  }
}

const MAX_WATCHED_BALLS = 160;

/** A ball from this car's gun in this seat hit something worth a hit marker. */
export function hitMarkFx(car: Car, seat: number) {
  if (share(FX.hitMark, hitMarkFx, [car, seat])) return;
  for (const h of G.humans)
    if (h.car === car && h.seat === seat && !h.remote) {
      h.hitMark = 1;
      SFX.hit();
    }
}

/** The labels points come with, and how each pops up. Anything else is ignored. */
const AWARD_STYLES: readonly (readonly [RegExp, string])[] = [
  [/^ROUND WIN$/, 'win'],
  [/^WRECK$/, 'wreck'],
  [/^(RADAR )?HEADSHOT$/, 'hs'],
  [/^BURN \d{1,2}\.\ds$/, 'burn'],
];

/** Points for a car: they pop up in the views of the people in it. */
export function awardFx(car: Car, pts: number, label: string) {
  if (share(FX.award, awardFx, [car, pts, label])) return;
  const style = AWARD_STYLES.find(([re]) => re.test(label));
  if (!style) return;
  for (const h of G.humans) if (h.car === car) popPoints(h, `+${Math.round(pts)} ${label}`, style[1]);
}

/** by shot off car's radar. */
export function feedRadarFx(by: Car, car: Car, pts: number) {
  if (share(FX.feedRadar, feedRadarFx, [by, car, pts])) return;
  feed(
    `<b style="--c:${requireValue(TEAMS[by.team]).ui}">${carLabel(by)}</b> took out <b style="--c:${requireValue(TEAMS[car.team]).ui}">${carLabel(car)}</b>'s radar <span class="hs">HEADSHOT +${Math.round(pts)}</span>`,
  );
}

/** A long burn, banked. */
export function feedBurnFx(car: Car, seconds: number, pts: number) {
  if (share(FX.feedBurn, feedBurnFx, [car, seconds, pts])) return;
  feed(
    `<b style="--c:${requireValue(TEAMS[car.team]).ui}">${carLabel(car)}</b> held a ${seconds.toFixed(1)} s burn <span class="burnf">+${Math.round(pts)}</span>`,
  );
}

/** The notes a crew gets on its screens, by number (part of the wire format: append only). */
export const NOTES = [
  ['RADAR DOWN!', '#ff5468'],
  ['+1 FUEL CAN', 'fuel'],
  ['REFUELLED', 'fuel'],
  ['+1 SPARE TYRE', 'tyre'],
  ['NEW TYRE FITTED', 'tyre'],
  ['BUMPERS FITTED', 'bumper'],
  ['+3 BUMPERS', 'bumper'],
  ['NEW WINDSCREEN', 'glass'],
  ['+1 WINDSCREEN', 'glass'],
] as const;

/** A note for one car's crew, in the colour of what it's about. */
export function noteFx(car: Car, note: number) {
  if (share(FX.note, noteFx, [car, note])) return;
  const n = NOTES[note];
  if (!n) return;
  const color = isDropKind(n[1]) ? DROP_TYPES[n[1]].ui : n[1];
  crewNote(car, n[0], color);
}

/** A radar shot off: the crew of the car that did it gets the hit and kill marks. */
export function headshotMarkFx(by: Car) {
  if (share(FX.headshotMark, headshotMarkFx, [by])) return;
  for (const h of G.humans)
    if (h.car === by) {
      h.hitMark = 1;
      h.killMark = 1;
    }
}

/** A burn ended: banked (a chime for its crew; the points come as an award) or lost to a knock. */
export function burnEndFx(car: Car, kept: boolean) {
  if (share(FX.burnEnd, burnEndFx, [car, kept])) return;
  const crew = G.humans.filter((h) => h.car === car);
  if (kept) {
    if (crew.length) SFX.pickup();
  } else for (const h of crew) popPoints(h, 'BURN LOST', 'lost');
}

const _rh = new THREE.Vector3();
/** A hit on a car's radar head: sparks fly off it. */
export function radarHitFx(car: Car) {
  if (share(FX.radarHit, radarHitFx, [car])) return;
  const p = carToWorld(car, 0, CARDIM.top + RADAR.headY, RADAR.z, _rh);
  sparks(p.x, p.y, p.z, 6, 3);
}

/** Composition adapter: score rules emit typed events, presentation replays the existing shared effects. */
export function playScoreEvent(event: ScoreEvent): void {
  switch (event.kind) {
    case 'award':
      awardFx(presentedCar(event.car), event.points, event.label);
      break;
    case 'radar':
      feedRadarFx(presentedCar(event.source), presentedCar(event.victim), event.points);
      break;
    case 'headshot':
      headshotMarkFx(presentedCar(event.car));
      break;
    case 'burnFeed':
      feedBurnFx(presentedCar(event.car), event.seconds, event.points);
      break;
    case 'burnEnd':
      burnEndFx(presentedCar(event.car), event.keep);
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unknown score event: ${exhaustive}`);
    }
  }
}

function presentedCar(value: import('./gameplay/scoring.ts').ScoringCar): Car {
  const car = G.cars.find((candidate) => candidate === value);
  if (!car) throw new Error('Score event references an unregistered car');
  return car;
}
