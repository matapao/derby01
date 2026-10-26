export type RenderMode = 'auto' | 'performance' | 'sharp';
export const RENDER_BUDGETS = { auto: 1_000_000, performance: 650_000, sharp: 1_500_000 } as const;
const AUTO_BUDGETS = [RENDER_BUDGETS.auto, 825_000, RENDER_BUDGETS.performance] as const;

export function isRenderMode(value: unknown): value is RenderMode {
  return value === 'auto' || value === 'performance' || value === 'sharp';
}

/** CSS pixels are sufficient on Retina screens; bound GPU work by total pixels, not screen height. */
export function renderDimensions(width: number, height: number, budget: number) {
  if (!Number.isFinite(budget) || budget < 1) throw new RangeError('Invalid render pixel budget');
  const bounded = (size: number) =>
    Math.max(1, Math.min(16_384, Math.floor(Number.isFinite(size) ? size : 1)));
  const w = bounded(width);
  const h = bounded(height);
  const pixelRatio = Math.min(1, Math.sqrt(budget / (w * h)));
  return {
    width: w,
    height: h,
    pixelRatio,
    bufferWidth: Math.max(1, Math.floor(w * pixelRatio)),
    bufferHeight: Math.max(1, Math.floor(h * pixelRatio)),
  };
}

/** Separate thresholds and a cooldown prevent resolution oscillation; sustained headroom restores detail. */
export function createRenderQuality() {
  let mode: RenderMode = 'auto';
  let level = 0;
  let seconds = 0;
  let frames = 0;
  let slowSeconds = 0;
  let fastSeconds = 0;
  let cooldown = 0;
  function resetWindow(): void {
    seconds = frames = slowSeconds = fastSeconds = 0;
  }
  function setMode(next: RenderMode): void {
    if (!isRenderMode(next)) throw new RangeError('Unknown render mode');
    if (next === mode) return;
    mode = next;
    level = 0;
    cooldown = 0;
    resetWindow();
  }
  function observe(dt: number, playing: boolean): boolean {
    if (mode !== 'auto' || !playing || !Number.isFinite(dt) || dt <= 0 || dt > 0.25) {
      resetWindow();
      return false;
    }
    if (cooldown > 0) {
      cooldown = Math.max(0, cooldown - dt);
      return false;
    }
    seconds += dt;
    frames++;
    if (seconds < 2) return false;
    const average = seconds / frames;
    if (average > 1 / 40) {
      slowSeconds += seconds;
      fastSeconds = 0;
    } else if (average < 1 / 55) {
      fastSeconds += seconds;
      slowSeconds = 0;
    } else slowSeconds = fastSeconds = 0;
    seconds = frames = 0;
    if (slowSeconds >= 4 && level < AUTO_BUDGETS.length - 1) level++;
    else if (fastSeconds >= 10 && level > 0) level--;
    else return false;
    cooldown = 6;
    resetWindow();
    return true;
  }
  return {
    setMode,
    observe,
    get mode(): RenderMode {
      return mode;
    },
    get budget(): number {
      return mode === 'auto' ? (AUTO_BUDGETS[level] ?? RENDER_BUDGETS.auto) : RENDER_BUDGETS[mode];
    },
  };
}
