/** A blend point between two snapshots: draw a + (b - a) * t. */
export interface Sample<T> {
  a: T;
  b: T;
  t: number;
  /** ms past the newest snapshot (then a and b are both the newest). */
  over: number;
}

/**
 * Snapshot interpolation: push states stamped with hub time as they arrive, then sample a little
 * in the past (net.now() minus about 1.5 snapshot intervals) to draw others smoothly.
 * The sample object is reused: read it before the next call.
 */
export class Interp<T> {
  private readonly size: number;
  private readonly times: Float64Array;
  private readonly values: T[];
  private head = 0;
  private count = 0;
  private out: Sample<T> | null = null;

  constructor(size = 32) {
    this.size = size;
    this.times = new Float64Array(size);
    this.values = new Array<T>(size);
  }

  /** Adds a state stamped with hub time t. States not newer than the newest are ignored. */
  push(t: number, v: T): boolean {
    const n = this.size;
    if (this.count && t <= this.times[(this.head - 1 + n) % n]!) return false;
    this.times[this.head] = t;
    this.values[this.head] = v;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count++;
    this.out ??= { a: v, b: v, t: 0, over: 0 };
    return true;
  }

  /** Where to draw at hub time t, or null before the first state. */
  sample(t: number): Sample<T> | null {
    const o = this.out;
    if (!this.count || !o) return null;
    const n = this.size, newest = (this.head - 1 + n) % n;
    for (let k = 0; k < this.count; k++) {
      const i = (newest - k + n) % n;
      const ti = this.times[i]!;
      if (ti <= t) {
        if (k === 0) {
          o.a = o.b = this.values[i]!;
          o.t = 1;
          o.over = t - ti;
          return o;
        }
        const j = (i + 1) % n, tj = this.times[j]!;
        o.a = this.values[i]!;
        o.b = this.values[j]!;
        o.t = (t - ti) / (tj - ti);
        o.over = 0;
        return o;
      }
    }
    const oldest = (newest - this.count + 1 + n) % n;
    o.a = o.b = this.values[oldest]!;
    o.t = 0;
    o.over = 0;
    return o;
  }

  newest(): T | null {
    return this.count ? this.values[(this.head - 1 + this.size) % this.size]! : null;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
