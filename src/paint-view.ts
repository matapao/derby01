export type PaintLayerContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'clearRect'
  | 'drawImage'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'globalAlpha'
  | 'globalCompositeOperation'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
>;

export interface PaintSurface {
  cv: CanvasImageSource;
  w: number;
  h: number;
  cover: number;
  ang: number;
  wipers: readonly { x: number; y: number; len: number }[];
  crack: { cv: CanvasImageSource; level: number } | null;
}

/** Cockpit glass is already drawn in 3D; turret feeds have their own painted camera lenses. */
export function paintViewSurface(
  seat: number,
  camMode: string,
  active: boolean,
): 'shield' | 'hood' | 'trunk' | null {
  if (!active) return null;
  if (seat === 0 && camMode === 'chase') return 'shield';
  if (seat === 1) return 'hood';
  if (seat === 2) return 'trunk';
  return null;
}

/** Camera paint clears uniformly, without an invisible windshield sweep. Limit tab-resume jumps. */
export function fadeCameraPaint(
  context: PaintLayerContext,
  width: number,
  height: number,
  cover: number,
  dt: number,
): number {
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(cover) || cover <= 0) return cover;
  if (cover < 0.003) {
    context.clearRect(0, 0, width, height);
    return 0;
  }
  const retained = Math.exp(-0.35 * Math.min(dt, 0.25));
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.globalAlpha = 1;
  context.fillStyle = `rgba(0,0,0,${1 - retained})`;
  context.fillRect(0, 0, width, height);
  context.restore();
  return Math.min(1, cover) * retained;
}

export type WipeContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'arc'
  | 'moveTo'
  | 'closePath'
  | 'fill'
  | 'globalCompositeOperation'
  | 'fillStyle'
>;

export interface WipedSurface {
  w: number;
  h: number;
  cover: number;
  wipers: readonly { x: number; y: number; len: number }[];
}

/**
 * Windshield paint stays until a blade passes over it. Blades moving from angle `from` to `to` thin
 * what they sweep by a fifth, a little more in some bands (streaks), so a direct hit takes a few
 * passes (two seconds or so) to see through. Returns the paint cover left.
 */
export function wipeShieldPaint(context: WipeContext, glass: WipedSurface, from: number, to: number): number {
  if (glass.cover < 0.003) return 0;
  const lo = Math.min(from, to) + Math.PI,
    hi = Math.max(from, to) + Math.PI;
  if (!(hi - lo >= 1e-4)) return glass.cover;
  context.save();
  context.globalCompositeOperation = 'destination-out';
  let area = 0;
  for (const wp of glass.wipers) {
    const r0 = wp.len * 0.12;
    context.beginPath();
    context.arc(wp.x, wp.y, wp.len, lo, hi);
    context.arc(wp.x, wp.y, r0, hi, lo, true);
    context.closePath();
    context.fillStyle = 'rgba(0,0,0,0.2)';
    context.fill();
    // the rubber wipes cleaner in some bands: streaks
    context.beginPath();
    for (let r = r0 + 5; r < wp.len - 4; r += 10) {
      context.moveTo(wp.x + Math.cos(lo) * (r + 5), wp.y + Math.sin(lo) * (r + 5));
      context.arc(wp.x, wp.y, r + 5, lo, hi);
      context.arc(wp.x, wp.y, r, hi, lo, true);
      context.closePath();
    }
    context.fillStyle = 'rgba(0,0,0,0.12)';
    context.fill();
    area += 0.5 * (wp.len * wp.len - r0 * r0) * (hi - lo);
  }
  context.restore();
  return glass.cover * (1 - 0.22 * Math.min(1, (area * 0.62) / (glass.w * glass.h)));
}

/** Only a car windshield has cracks or blades. A camera feed can show paint, never glass effects. */
export function drawPaintLayer(
  context: PaintLayerContext,
  surface: PaintSurface,
  width: number,
  height: number,
  windshield: boolean,
): void {
  context.save();
  if (windshield && surface.crack && surface.crack.level > 0)
    context.drawImage(surface.crack.cv, 0, 0, width, height);
  context.globalAlpha = windshield ? 0.8 : 0.94;
  context.drawImage(surface.cv, 0, 0, width, height);
  context.globalAlpha = 1;
  if (windshield) {
    const sx = width / surface.w;
    const sy = height / surface.h;
    const angle = surface.ang + Math.PI;
    context.lineCap = 'round';
    for (const blade of surface.wipers) {
      const x = blade.x * sx;
      const y = blade.y * sy;
      const endX = x + Math.cos(angle) * blade.len * sx;
      const endY = y + Math.sin(angle) * blade.len * sy;
      context.strokeStyle = `rgba(10,10,12,${surface.cover > 0.04 ? 0.9 : 0.5})`;
      context.lineWidth = Math.max(3, height * 0.011);
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(endX, endY);
      context.stroke();
      context.strokeStyle = 'rgba(255,255,255,0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x - 2, y - 1);
      context.lineTo(endX - 2, endY - 1);
      context.stroke();
    }
  }
  context.restore();
}
