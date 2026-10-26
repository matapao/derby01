import type { EffectArguments } from './effect-types.ts';
/**
 * Effects every screen draws alike: splats, dents, cracks, crashes, shots, wrecks. A shared effect
 * starts with one line,
 *
 *   if (share(FX.dent, dentCar, arguments)) return;
 *
 * and then does what it always did. On the host, with other players in the room, share() records the
 * effect (its arguments and a random seed), runs it under that seed, and returns true. Everywhere else
 * it returns false and the function goes on as normal: offline, inside another shared effect, and when
 * another screen replays a recorded effect (replayEffects), under the same seed, so even the random
 * parts come out the same.
 */
import { newSeed, withSeed } from './seeded.ts';
import type { Reader, Writer } from '/zirbel-net.js';

/** The shared effects, by id (part of the wire format: append only). */
export const FX = {
  dent: 1,
  paintHitCar: 2,
  paintImpact: 3,
  groundSplat: 4,
  wallSplat: 5,
  paintBurst: 6,
  crackFromKnock: 7,
  crackWindshield: 8,
  crackGlassAt: 9,
  crash: 10,
  knock: 11,
  wreck: 12,
  shot: 13,
  hitMark: 14,
  award: 15,
  feedRadar: 16,
  feedBurn: 17,
  note: 18,
  breakProp: 19,
  placeDrop: 20,
  takeDrop: 21,
  headshotMark: 22,
  burnEnd: 23,
  radarHit: 24,
} as const;
export type EffectId = (typeof FX)[keyof typeof FX];

/** How one effect's arguments travel. read() must check what it reads: it comes from another screen. */
export interface EffectCodec<I extends EffectId> {
  write(w: Writer, args: EffectArguments[I]): void;
  read(r: Reader): EffectArguments[I] | null;
}
type EffectFn<I extends EffectId> = (...args: EffectArguments[I]) => unknown;
interface Entry<I extends EffectId> {
  readonly codec: EffectCodec<I>;
  readonly fn: EffectFn<I>;
  replay(seed: number, reader: Reader): void;
}
const effects: { [I in EffectId]?: Entry<I> } = {};
export function defineEffect<I extends EffectId>(
  id: I,
  fn: EffectFn<NoInfer<I>>,
  codec: EffectCodec<NoInfer<I>>,
): void {
  if (effects[id]) throw new Error(`effect ${id} defined twice`);
  const entry: Entry<I> = {
    codec,
    fn,
    replay(seed, reader) {
      const args = codec.read(reader);
      if (!reader.overrun && args) run(seed, fn, args);
    },
  };
  // The closure retains the id/tuple relationship across the heterogeneous registry.
  Object.defineProperty(effects, id, { value: entry, enumerable: true });
}

/** Where recorded effects go: set by the host's session while other players are in the room. */
let sink: Writer | null = null;
let count = 0;
let depth = 0; // > 0 while a shared effect runs: what it calls isn't recorded again

export function recordInto(w: Writer | null): void {
  sink = w;
  count = 0;
}
/** How many effects were recorded since recordInto(). */
export function recorded(): number {
  return count;
}

export function share<I extends EffectId>(
  id: I,
  fn: EffectFn<NoInfer<I>>,
  args: EffectArguments[NoInfer<I>],
): boolean {
  if (!sink || depth > 0) return false;
  const e = effects[id];
  if (!e || e.fn !== fn) throw new Error(`effect ${id} isn't defined for this function`);
  const list = args;
  const seed = newSeed();
  sink.u8(id).u32(seed);
  e.codec.write(sink, list);
  count++;
  run(seed, fn, list);
  return true;
}

function run<I extends EffectId>(seed: number, fn: EffectFn<I>, args: EffectArguments[I]): void {
  depth++;
  try {
    withSeed(seed, () => fn(...args));
  } finally {
    depth--;
  }
}

/**
 * How many effects other screens play: per message, and per second over all of them, with room
 * for a burst. A host's frame records a handful; anything far beyond is dropped, not played.
 */
const PER_MESSAGE = 128,
  PER_SECOND = 600;
let budget = PER_SECOND,
  budgetAt = 0;

/** Plays a batch of effects recorded on the host: [id, seed, arguments] until the message ends. */
export function replayEffects(r: Reader, max = PER_MESSAGE): void {
  const now = performance.now();
  budget = Math.min(PER_SECOND, budget + ((now - budgetAt) / 1000) * PER_SECOND);
  budgetAt = now;
  const most = Math.min(max, Math.floor(budget));
  let n = 0;
  try {
    while (n < most && r.left() > 0) {
      // Charge each attempted effect even if an unknown id, truncation or renderer ends the batch.
      n++;
      const id = r.u8(),
        seed = r.u32();
      if (!Object.hasOwn(effects, id)) return;
      const e = effects[id as EffectId];
      if (!e) return; // an effect this version doesn't know: the rest can't be read either
      e.replay(seed, r);
      if (r.overrun) break;
    }
  } finally {
    budget -= n;
  }
}
