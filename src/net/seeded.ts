/**
 * Seeded randomness for effects that every screen must draw the same: the host runs an effect with
 * Math.random seeded, sends the seed with the effect's arguments, and every other screen replays it
 * under the same seed. The game's own code keeps calling Math.random as it always has.
 */

/** mulberry32: a small, fast 32-bit generator, plenty for effects. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const unseeded = Math.random;

/** Runs fn with Math.random replaced by a generator seeded with seed, and puts it back after. */
export function withSeed<T>(seed: number, fn: () => T): T {
  const before = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = before;
  }
}

/** A fresh seed, from the real generator even while another effect is running seeded. */
export function newSeed(): number {
  return (unseeded() * 4294967296) >>> 0;
}
