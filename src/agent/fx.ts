/**
 * Reads the host's effect batches (MSG.fx) without the game: the play adapter runs where there is no
 * three.js and no DOM, so it can't use src/net/codecs.ts, which replays effects through the game's
 * own drawing code. This reads the same layouts with zirbel-net's Reader and keeps what an agent
 * needs to know (who hit whom, points, wrecks, drops, props knocked over) and skips the rest.
 *
 * The layouts must match src/net/codecs.ts exactly: an effect it can't read ends the batch, as it
 * does in replayEffects. test/play.test.ts replays recorded batches to keep the two in step.
 */
import type { Reader } from '/zirbel-net.js';

const NONE = 255;
const CAUSES = ['crash', 'wall', 'explosion', 'gun', 'landing', 'prop', 'fire'] as const;
const DROPS = ['fuel', 'tyre', 'bumper', 'glass'] as const;

export type Effect =
  | { fx: 'crash'; a: number | null; b: number | null; strength: number }
  | { fx: 'wreck'; car: number; by: number | null; cause: string | null; x: number; z: number }
  | { fx: 'shot'; car: number; seat: number }
  | { fx: 'hitMark'; car: number; seat: number }
  | { fx: 'award'; car: number; points: number; label: string }
  | { fx: 'feedRadar'; by: number; car: number; points: number }
  | { fx: 'feedBurn'; car: number; seconds: number; points: number }
  | { fx: 'note'; car: number; note: number }
  | { fx: 'breakProp'; index: number; car: number | null }
  | { fx: 'placeDrop'; id: number; type: (typeof DROPS)[number]; x: number; z: number }
  | { fx: 'takeDrop'; id: number }
  | { fx: 'radarMark'; by: number }
  | { fx: 'burnEnd'; car: number; kept: boolean }
  | { fx: 'radarHit'; car: number };

const car = (r: Reader): number | null => {
  const i = r.u8();
  return i === NONE ? null : i;
};
const world = (r: Reader): [number, number, number] => [r.q16(-400, 400), r.q16(-30, 90), r.q16(-400, 400)];
const local = (r: Reader): void => {
  r.q16(-4, 4);
  r.q16(-4, 4);
  r.q16(-4, 4);
};
const dir = (r: Reader): void => {
  r.q8(-1.5, 1.5);
  r.q8(-1.5, 1.5);
  r.q8(-1.5, 1.5);
};

/** Each effect's arguments, read in the order codecs.ts writes them; null for one this can't read. */
const READ: Record<number, (r: Reader) => Effect | undefined> = {
  1: (r) => {
    r.u8();
    local(r);
    dir(r);
    r.q16(0, 60);
    return undefined;
  }, // dent
  2: (r) => {
    r.u8();
    local(r);
    r.u8();
    r.i8();
    r.u8();
    return undefined;
  }, // paintHitCar
  3: (r) => {
    world(r);
    dir(r);
    if (r.bool()) {
      r.q16(-150, 150);
      r.q16(-150, 150);
      r.q16(-150, 150);
    }
    r.u8();
    r.q8(0, 4);
    return undefined;
  }, // paintImpact
  4: (r) => {
    r.q16(-400, 400);
    r.q16(-400, 400);
    r.q8(0, 10);
    r.u8();
    r.q16(-5, 60);
    return undefined;
  }, // groundSplat
  5: (r) => {
    world(r);
    dir(r);
    r.q8(0, 10);
    r.u8();
    return undefined;
  }, // wallSplat
  6: (r) => {
    world(r);
    r.u8();
    r.bool();
    return undefined;
  }, // paintBurst
  7: (r) => {
    r.u8();
    r.u8();
    r.u8();
    r.q16(0, 80);
    return undefined;
  }, // crackFromKnock
  8: (r) => {
    r.u8();
    r.q8(0, 1);
    r.q8(0, 1);
    r.q8(0, 4);
    return undefined;
  }, // crackWindshield
  9: (r) => {
    r.u8();
    local(r);
    r.q8(0, 4);
    return undefined;
  }, // crackGlassAt
  10: (r) => {
    world(r);
    const strength = r.q16(0, 80),
      a = car(r),
      b = car(r);
    return { fx: 'crash', a, b, strength };
  },
  11: (r) => {
    r.u8();
    r.u8();
    world(r);
    r.q16(0, 80);
    return undefined;
  }, // knock
  12: (r) => {
    const c = r.u8(),
      by = car(r),
      k = r.u8(),
      [x, , z] = world(r);
    return { fx: 'wreck', car: c, by, cause: k === NONE ? null : (CAUSES[k] ?? null), x, z };
  },
  13: (r) => {
    const c = r.u8(),
      seat = r.u8();
    world(r);
    r.q16(-150, 150);
    r.q16(-150, 150);
    r.q16(-150, 150);
    return { fx: 'shot', car: c, seat };
  },
  14: (r) => ({ fx: 'hitMark', car: r.u8(), seat: r.u8() }),
  15: (r) => {
    const c = r.u8(),
      points = r.q16(0, 5000),
      label = r.str().slice(0, 24);
    return { fx: 'award', car: c, points, label };
  },
  16: (r) => {
    const by = r.u8(),
      c = r.u8(),
      points = r.q16(0, 5000);
    return { fx: 'feedRadar', by, car: c, points };
  },
  17: (r) => {
    const c = r.u8(),
      seconds = r.q8(0, 15),
      points = r.q16(0, 5000);
    return { fx: 'feedBurn', car: c, seconds, points };
  },
  18: (r) => ({ fx: 'note', car: r.u8(), note: r.u8() }),
  19: (r) => {
    const index = r.u16();
    r.q8(-1, 1);
    r.q8(-1, 1);
    r.q8(0, 60);
    return { fx: 'breakProp', index, car: car(r) };
  },
  20: (r) => {
    const id = r.u32(),
      t = r.u8(),
      x = r.q16(-400, 400),
      z = r.q16(-400, 400);
    r.q8(0, 6);
    const type = DROPS[t];
    return type ? { fx: 'placeDrop', id, type, x, z } : undefined;
  },
  21: (r) => ({ fx: 'takeDrop', id: r.u32() }),
  22: (r) => ({ fx: 'radarMark', by: r.u8() }),
  23: (r) => {
    const c = r.u8();
    return { fx: 'burnEnd', car: c, kept: r.u8() === 1 };
  },
  24: (r) => ({ fx: 'radarHit', car: r.u8() }),
};

/** The effects in one batch: [id, seed, arguments] until the message ends. */
export function readEffects(r: Reader, max = 512): Effect[] {
  const out: Effect[] = [];
  for (let n = 0; n < max && r.left() > 0; n++) {
    const id = r.u8();
    r.u32(); // the seed the other screens draw it with
    const read = READ[id];
    if (!read) break; // an effect this version doesn't know: the rest can't be read either
    const e = read(r);
    if (r.overrun) break;
    if (e) out.push(e);
  }
  return out;
}

/** The notes a crew gets on its screens (sharedfx.ts NOTES), by number. */
export const NOTES = [
  'RADAR DOWN!',
  '+1 FUEL CAN',
  'REFUELLED',
  '+1 SPARE TYRE',
  'NEW TYRE FITTED',
  'BUMPERS FITTED',
  '+3 BUMPERS',
  'NEW WINDSCREEN',
  '+1 WINDSCREEN',
] as const;
