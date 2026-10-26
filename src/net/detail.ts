/**
 * The slower state of a car: its systems, spares, bumpers, panels, wheels, kit, radar and glass.
 * The host sends a car's detail whenever it changes; the other screens bring their car to match,
 * and whatever came off flies off there too (the pieces fly differently on each screen; that's fine).
 * Everything read here comes from another screen, so every field is checked and clamped.
 */
import { requireValue } from '../required-fields.ts';
import { DETACHABLE } from '../core.ts';
import { BUMPER_NAMES, dropWheel, refitWheel, setBumperPieces } from '../car.ts';
import { detachKit } from '../kits.ts';
import { clearWindshieldCracks } from '../paint.ts';
import { knockRadarOff } from '../radar.ts';
import { fitRadarHead } from '../radar-model.ts';
import { detachPart } from '../physics.ts';
import type { Car } from '../car.ts';
import { bodyworkDetail, decodeBodyworkDetail, type BodyworkDetail } from '../gameplay/body-damage.ts';

export interface CarDetail {
  i: number;
  sys: {
    engine: number;
    fuel: number;
    leak: boolean;
    fire: number;
    maxHp: number;
    tires: number[];
    tireHp: number[];
    rim: number[];
    wheelOff: boolean[];
    axles: number[];
  };
  power: number;
  stock: { fuel: number; tyres: number; bumpers: number; glass: number };
  bumpers: { hp: number; on: number }[];
  /** Panels still on, one bit per DETACHABLE name; wheels still on, one bit each; kit parts still on. */
  parts: number;
  wheels: number;
  kit: number;
  radar: { hp: number; off: boolean };
  crack: { level: number; shattered: boolean };
  /** Damage at the front and back: the lights follow it. */
  front: number;
  rear: number;
  bodywork?: BodyworkDetail;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const bits = (list: readonly boolean[]): number => list.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);

export function carDetail(car: Car): CarDetail {
  const s = car.sys;
  return {
    i: car.idx,
    sys: {
      engine: round1(s.engine),
      fuel: round1(s.fuel),
      leak: !!s.leak,
      fire: s.fire | 0,
      maxHp: round1(s.maxHp),
      tires: s.tires.map((t: number) => (t ? 1 : 0)),
      tireHp: s.tireHp.map(round1),
      rim: s.rim.map(round1),
      wheelOff: s.wheelOff.map(Boolean),
      axles: s.axles.map((a: number) => (a ? 1 : 0)),
    },
    power: round1(car.mods.power),
    stock: { ...car.stock },
    bumpers: BUMPER_NAMES.map((n: string) => ({
      hp: round1(requireValue(car.bumpers[n]).hp),
      on: bits(requireValue(car.bumpers[n]).pieces.map(Boolean)),
    })),
    parts: bits(DETACHABLE.map((n: string) => !!car.parts[n])),
    wheels: bits(car.wheels.map((w: { attached: boolean }) => w.attached)),
    kit: bits((car.kit || []).map((p: { gone: boolean }) => !p.gone)),
    radar: { hp: round1(car.radar.hp), off: !!car.radar.destroyed },
    crack: {
      level: Math.round(car.glass.shield.crack.level * 100) / 100,
      shattered: !!car.glass.shield.crack.shattered,
    },
    front: round1(car.zoneDmg.front),
    rear: round1(car.zoneDmg.rear),
    bodywork: bodyworkDetail(car.bodywork),
  };
}

// ---- reading another screen's detail: never trust its shape ----

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
const int = (v: unknown, lo: number, hi: number, dflt: number): number => Math.round(num(v, lo, hi, dflt));
const list = (v: unknown, n: number): unknown[] =>
  Array.isArray(v) && v.length === n ? v : new Array(n).fill(undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const on = (mask: number, i: number): boolean => !!(mask & (1 << i));

/** Brings this screen's car in line with the host's detail. */
export function applyDetail(car: Car, raw: unknown): void {
  const d = obj(raw);
  const sys = obj(d['sys']),
    s = car.sys;
  s.engine = num(sys['engine'], 0, 100, s.engine);
  // while this screen's mechanic pours, the tank is theirs to show (the host gets the fuel as it goes in)
  if (!car.pouring) s.fuel = num(sys['fuel'], 0, 100, s.fuel);
  s.leak = sys['leak'] === true;
  s.fire = int(sys['fire'], 0, 3, 0);
  s.maxHp = num(sys['maxHp'], 0, 100, s.maxHp);
  list(sys['tires'], 4).forEach((v, i) => {
    s.tires[i] = int(v, 0, 1, requireValue(s.tires[i]));
  });
  list(sys['tireHp'], 4).forEach((v, i) => {
    s.tireHp[i] = num(v, 0, 100, requireValue(s.tireHp[i]));
  });
  list(sys['rim'], 4).forEach((v, i) => {
    s.rim[i] = num(v, 0, 100, requireValue(s.rim[i]));
  });
  list(sys['axles'], 2).forEach((v, i) => {
    s.axles[i] = int(v, 0, 1, requireValue(s.axles[i]));
  });
  const off = list(sys['wheelOff'], 4).map((v) => v === true);
  car.mods.power = num(d['power'], 0, 1.5, car.mods.power);
  const st = obj(d['stock']);
  for (const k of ['fuel', 'tyres', 'bumpers', 'glass'] as const)
    car.stock[k] = int(st[k], 0, 99, car.stock[k]);

  // bumpers: pieces on or off as the host has them, then hanging as their health says
  list(d['bumpers'], BUMPER_NAMES.length).forEach((v, k) => {
    const b = obj(v),
      name = requireValue(BUMPER_NAMES[k]);
    setBumperPieces(
      car,
      name,
      int(b['on'], 0, 0xffff, 0xffff),
      num(b['hp'], 0, 999, requireValue(car.bumpers[name]).hp),
    );
  });
  // panels and wheels that came off here too; wheels the mechanic bolted back on
  const parts = int(d['parts'], 0, 0xffff, 0xffff);
  DETACHABLE.forEach((n: string, i: number) => {
    if (!on(parts, i) && car.parts[n]) detachPart(car, n, 1);
  });
  const wheels = int(d['wheels'], 0, 0xf, 0xf);
  car.wheels.forEach((w: { attached: boolean }, i: number) => {
    if (on(wheels, i) && !w.attached) refitWheel(car, i);
    else if (!on(wheels, i) && w.attached) dropWheel(car, i);
    s.wheelOff[i] = off[i] ?? requireValue(s.wheelOff[i]);
  });
  const kit = int(d['kit'], 0, 0xffffff, 0xffffff);
  (car.kit || []).forEach((p, i: number) => {
    if (!on(kit, i) && !p.gone) detachKit(car, p, 1);
  });

  const radar = obj(d['radar']);
  const radarOff = radar['off'] === true;
  if (radarOff && !car.radar.destroyed) knockRadarOff(car);
  else if (!radarOff && car.radar.destroyed) fitRadarHead(car);
  car.radar.hp = num(radar['hp'], 0, 999, car.radar.hp);

  // a new windscreen: the cracks go (the cracks themselves come as effects)
  const crack = obj(d['crack']),
    C = car.glass.shield.crack;
  const level = num(crack['level'], 0, 1.2, C.level);
  if (level < C.level - 0.1) clearWindshieldCracks(car);
  C.level = level;
  C.shattered = crack['shattered'] === true;
  car.zoneDmg.front = num(d['front'], 0, 9999, car.zoneDmg.front);
  car.zoneDmg.rear = num(d['rear'], 0, 9999, car.zoneDmg.rear);
  car.bodywork = decodeBodyworkDetail(d['bodywork'], car.bodywork);
}
